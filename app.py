from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit
import time
import random
import threading
import os

app = Flask(__name__)
app.config['SECRET_KEY'] = 'CHANGEME69'
socketio = SocketIO(app, async_mode='threading')

gameState = {
    "status": "WAITING",
    "currentMultiplier": 1.00,
    "crashPoint": 0.0,
    "timeToNextRound": 10,
    "players": {},
    "history": [],
    "liveBets": {}
}
gameLock = threading.Lock()

def generateCrashPoint():
    if random.random() < 0.03: return 1.00
    r = random.uniform(0, 0.99)
    crashVal = 1 / (1 - r)
    return max(1.01, round(crashVal, 2))

def resetRound():
    with gameLock:
        gameState["status"] = "WAITING"
        gameState["currentMultiplier"] = 1.00
        gameState["crashPoint"] = 0.0
        gameState["timeToNextRound"] = 10
        gameState["liveBets"] = {}
        for sid in gameState["players"]:
            if sid in gameState["players"]:
                gameState["players"][sid]["currentBet"] = None
                gameState["players"][sid]["cashedOutAt"] = None
        socketio.emit('gameStateUpdate', gameState)
        socketio.emit('liveBetsClear')

def gameLoop():
    while True:
        resetRound()

        for i in range(gameState["timeToNextRound"], 0, -1):
            with gameLock:
                gameState["timeToNextRound"] = i
            socketio.emit('timerUpdate', {"timeToNextRound": i})
            socketio.sleep(1)

        with gameLock:
            gameState["status"] = "RUNNING"
            gameState["crashPoint"] = generateCrashPoint()
            gameState["currentMultiplier"] = 1.00
        socketio.emit('gameStateUpdate', gameState)
        print(f"Game loop: RUNNING, Target Crash at {gameState['crashPoint']:.2f}x")

        startTime = time.time()
        incrementDelay = 0.05

        while gameState["status"] == "RUNNING":
            elapsedTime = time.time() - startTime
            newMultiplier = round(1.00 + (elapsedTime * 0.15) + (elapsedTime**2 * 0.035), 2)

            with gameLock:
                gameState["currentMultiplier"] = newMultiplier

                for sid, playerData in list(gameState["players"].items()):
                    if sid not in gameState["players"]: continue

                    betInfo = playerData.get("currentBet")
                    if betInfo and betInfo["amount"] > 0 and not playerData["cashedOutAt"]:
                        autoCashoutTarget = betInfo.get("autoCashoutAt")
                        if autoCashoutTarget and gameState["currentMultiplier"] >= autoCashoutTarget:
                            cashoutVal = min(gameState["currentMultiplier"], autoCashoutTarget)
                            playerData["cashedOutAt"] = cashoutVal
                            
                            print(f"Player {playerData['username']} auto-cashed out at {cashoutVal:.2f}x (target: {autoCashoutTarget:.2f}x, current: {gameState['currentMultiplier']:.2f}x)")
                            
                            if sid in gameState["liveBets"]:
                                gameState["liveBets"][sid]["status"] = f"Cashed @ {cashoutVal:.2f}x"
                                socketio.emit('liveBetUpdate', {"sid": sid, "data": gameState["liveBets"][sid]})

                if gameState["currentMultiplier"] >= gameState["crashPoint"]:
                    gameState["currentMultiplier"] = gameState["crashPoint"]
                    gameState["status"] = "CRASHED"

            socketio.emit('multiplierUpdate', {"multiplier": gameState["currentMultiplier"]})
            if gameState["status"] == "CRASHED":
                break
            socketio.sleep(incrementDelay)

        print(f"Game loop: CRASHED at {gameState['crashPoint']:.2f}x")
        with gameLock:
            gameState["history"].insert(0, gameState["crashPoint"])
            if len(gameState["history"]) > 15: gameState["history"].pop()

            for sid, playerData in list(gameState["players"].items()):
                if sid not in gameState["players"]: continue
                if playerData["currentBet"] and playerData["currentBet"]["amount"] > 0:
                    if playerData["cashedOutAt"]:
                        winnings = playerData["currentBet"]["amount"] * playerData["cashedOutAt"]
                        playerData["balance"] += winnings
                        socketio.emit('roundResult', {
                            "sid": sid, "won": True, "payout": playerData["cashedOutAt"],
                            "winnings": winnings, "balance": playerData["balance"]}, room=sid)
                    else:
                        socketio.emit('roundResult', {
                            "sid": sid, "won": False, "payout": 0, "winnings": 0,
                            "currentBetAmount": playerData["currentBet"]["amount"],
                            "balance": playerData["balance"]}, room=sid)
                        if sid in gameState["liveBets"]:
                             gameState["liveBets"][sid]["status"] = f"Lost"
                             socketio.emit('liveBetUpdate', {"sid": sid, "data": gameState["liveBets"][sid]})

                playerData["currentBet"] = None
                playerData["cashedOutAt"] = None

        socketio.emit('gameStateUpdate', gameState)
        socketio.sleep(5)

@app.route('/')
def index():
    return render_template('index.html')

@socketio.on('connect')
def handleConnect():
    sid = request.sid
    with gameLock:
        if sid not in gameState["players"]:
            gameState["players"][sid] = {
                "username": f"User_{sid[:4]}", "balance": 1000.00,
                "currentBet": None, "cashedOutAt": None
            }
    print(f"Client connected: {sid}, Username: {gameState['players'][sid]['username']}")
    emit('gameStateUpdate', gameState)
    emit('playerUpdate', gameState["players"][sid], room=sid)
    with gameLock:
        emit('initialLiveBets', gameState["liveBets"], room=sid)

@socketio.on('disconnect')
def handleDisconnect():
    sid = request.sid
    print(f"Client disconnected: {sid}")
    with gameLock:
        if sid in gameState["players"]: del gameState["players"][sid]
        if sid in gameState["liveBets"]:
            del gameState["liveBets"][sid]
            socketio.emit('liveBetRemove', {"sid": sid})

@socketio.on('placeBet')
def handlePlaceBet(data):
    sid = request.sid
    try:
        betAmount = float(data.get('amount', 0))
        autoCashoutStr = data.get('autoCashoutAt')
        autoCashoutAt = None
        if autoCashoutStr is not None:
            try:
                autoCashoutAt = float(autoCashoutStr)
                if autoCashoutAt <= 1.00:
                    emit('errorMessage', {"message": "Auto cashout must be > 1.00x"}, room=sid)
                    return
            except (ValueError, TypeError):
                emit('errorMessage', {"message": "Invalid auto cashout value."}, room=sid)
                return
    except ValueError:
        emit('errorMessage', {"message": "Invalid bet amount."}, room=sid)
        return

    with gameLock:
        player = gameState["players"].get(sid)
        if not player: emit('errorMessage', {"message": "Player not found. Please refresh."}, room=sid); return
        if gameState["status"] != "WAITING": emit('errorMessage', {"message": "Betting is closed for this round."}, room=sid); return
        if betAmount <= 0: emit('errorMessage', {"message": "Bet amount must be positive."}, room=sid); return
        if player["balance"] < betAmount: emit('errorMessage', {"message": "Insufficient balance."}, room=sid); return
        if player["currentBet"] and player["currentBet"]["amount"] > 0 : emit('errorMessage', {"message": "You have already placed a bet for this round."}, room=sid); return

        player["balance"] -= betAmount
        player["currentBet"] = {"amount": betAmount, "autoCashoutAt": autoCashoutAt}
        player["cashedOutAt"] = None

        liveBetData = {
            "username": player["username"],
            "betAmount": betAmount,
            "autoCashoutAt": autoCashoutAt,
            "status": "Active"
        }
        gameState["liveBets"][sid] = liveBetData
        socketio.emit('liveBetUpdate', {"sid": sid, "data": liveBetData})

        emit('playerUpdate', player, room=sid)
        emit('betPlacedAck', {"amount": betAmount, "balance": player["balance"], "autoCashoutAt": autoCashoutAt}, room=sid)

@socketio.on('cashOut')
def handleCashOut():
    sid = request.sid
    with gameLock:
        player = gameState["players"].get(sid)
        if not player: emit('errorMessage', {"message": "Player not found."}, room=sid); return
        if gameState["status"] != "RUNNING": emit('errorMessage', {"message": "Game is not running or has crashed."}, room=sid); return
        if not player["currentBet"] or player["currentBet"]["amount"] <= 0: emit('errorMessage', {"message": "No active bet to cash out."}, room=sid); return
        if player["cashedOutAt"] is not None: emit('errorMessage', {"message": "Already cashed out this round."}, room=sid); return

        player["cashedOutAt"] = gameState["currentMultiplier"]
        potentialWinnings = player["currentBet"]["amount"] * player["cashedOutAt"]

        if sid in gameState["liveBets"]:
            gameState["liveBets"][sid]["status"] = f"Cashed @ {player['cashedOutAt']:.2f}x"
            socketio.emit('liveBetUpdate', {"sid": sid, "data": gameState["liveBets"][sid]})

        emit('cashedOutAck', {"multiplier": player["cashedOutAt"], "potentialWinnings": potentialWinnings}, room=sid)

if __name__ == '__main__':
    print("Starting Crash server...")
    if not app.debug or os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        socketio.start_background_task(target=gameLoop)
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)
