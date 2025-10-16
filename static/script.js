document.addEventListener('DOMContentLoaded', () => {
    const socket = io();

    const multiplierValueDisplay = document.getElementById('multiplier-value');
    const gameStatusText = document.getElementById('game-status-text');
    const betAmountInput = document.getElementById('bet-amount');
    const placeBetBtn = document.getElementById('place-bet-btn');
    const cashOutBtn = document.getElementById('cash-out-btn');
    const playerBalanceDisplay = document.getElementById('player-balance');
    const playerUsernameDisplay = document.getElementById('player-username');
    const currentBetStatus = document.getElementById('current-bet-status');
    const roundResultInfo = document.getElementById('round-result-info');
    const errorMessageDisplay = document.getElementById('error-message');
    const crashHistoryList = document.getElementById('crash-history-list');
    const autoCashoutInput = document.getElementById('auto-cashout-multiplier');
    const clearAutoCashoutBtn = document.getElementById('clear-auto-cashout-btn');
    const liveBetsList = document.getElementById('live-bets-list');
    const rocketWrapper = document.getElementById('rocket-wrapper');
    const flightPathContainer = document.getElementById('flight-path-container');
    const trailCanvas = document.getElementById('rocket-trail-canvas');
    const trailCtx = trailCanvas ? trailCanvas.getContext('2d') : null;

    let mySID = null;
    let currentBetAmount = 0;
    let cashedOutThisRound = false;
    let currentAutoCashoutTarget = null;
    let displayedLiveBets = {};
    let gameRunning = false;
    let trailParticles = [];

    function updateAutoCashoutStatus() {
        if (currentAutoCashoutTarget) {
            currentBetStatus.textContent = `Auto Cashout: ${currentAutoCashoutTarget.toFixed(2)}x`;
        } else if (currentBetAmount > 0 && !cashedOutThisRound) {
             currentBetStatus.textContent = `Bet Placed: ${currentBetAmount.toFixed(2)}`;
        }
         else {
            currentBetStatus.textContent = "";
        }
    }

    autoCashoutInput.addEventListener('input', () => {
        const valStr = autoCashoutInput.value;
        if (valStr === "") {
            currentAutoCashoutTarget = null;
            updateAutoCashoutStatus();
            return;
        }
        const val = parseFloat(valStr);
        if (!isNaN(val) && val > 1.00) {
            currentAutoCashoutTarget = val;
        } else {
            currentAutoCashoutTarget = null;
        }
        updateAutoCashoutStatus();
    });

    clearAutoCashoutBtn.addEventListener('click', () => {
        autoCashoutInput.value = "";
        currentAutoCashoutTarget = null;
        updateAutoCashoutStatus();
    });

    function addOrUpdateLiveBet(sid, betData) {
        let listItem = displayedLiveBets[sid];
        if (!listItem) {
            listItem = document.createElement('li');
            listItem.id = `live-bet-${sid}`;
            liveBetsList.prepend(listItem);
            displayedLiveBets[sid] = listItem;
        }

        let autoCashoutDisplay = "";
        if (betData.autoCashoutAt) {
            autoCashoutDisplay = `<span class="bet-auto-cashout">(Auto @ ${parseFloat(betData.autoCashoutAt).toFixed(2)}x)</span>`;
        }

        let statusClass = 'active';
        if (betData.status && betData.status.includes('Cashed')) statusClass = 'cashed';
        if (betData.status && betData.status.includes('Lost')) statusClass = 'lost';

        let statusDisplay = betData.status !== "Active" ? `<span class="bet-status ${statusClass}">${betData.status}</span>` : "";

        listItem.innerHTML = `
            <div class="bet-player-details">
                <span class="bet-username">${betData.username}</span>
                <span class="bet-amount">${parseFloat(betData.betAmount).toFixed(2)}</span>
                ${autoCashoutDisplay}
            </div>
            ${statusDisplay}
        `;
    }

    socket.on('initialLiveBets', (allBets) => {
        liveBetsList.innerHTML = "";
        displayedLiveBets = {};
        const sids = Object.keys(allBets);
        sids.forEach(sid => {
            addOrUpdateLiveBet(sid, allBets[sid]);
        });
    });

    socket.on('liveBetUpdate', (payload) => {
        addOrUpdateLiveBet(payload.sid, payload.data);
    });

    socket.on('liveBetRemove', (payload) => {
        const listItem = displayedLiveBets[payload.sid];
        if (listItem) {
            listItem.remove();
            delete displayedLiveBets[payload.sid];
        }
    });

    socket.on('liveBetsClear', () => {
        liveBetsList.innerHTML = "";
        displayedLiveBets = {};
    });

    socket.on('connect', () => {
        mySID = socket.id;
        gameStatusText.textContent = 'Connected. Waiting for game...';
    });

    socket.on('playerUpdate', (playerData) => {
        playerBalanceDisplay.textContent = parseFloat(playerData.balance).toFixed(2);
        playerUsernameDisplay.textContent = playerData.username;
    });

    socket.on('gameStateUpdate', (gameState) => {
        updateMultiplierDisplay(gameState.currentMultiplier, gameState.status.toLowerCase());
        updateCrashHistory(gameState.history);
        updateRocketPosition(gameState.currentMultiplier, gameState.status);

        switch (gameState.status) {
            case 'WAITING':
                gameStatusText.textContent = `Next round in ${gameState.timeToNextRound}s. Place your bets!`;
                placeBetBtn.disabled = false;
                cashOutBtn.disabled = true;
                cashOutBtn.textContent = "Cash Out!";
                cashedOutThisRound = false;
                currentBetAmount = 0;
                roundResultInfo.textContent = "";
                roundResultInfo.className = 'message-text';
                updateAutoCashoutStatus();
                rocketWrapper.classList.remove('crashed');
                rocketWrapper.style.opacity = '1';
                initTrailCanvas();
                break;
            case 'RUNNING':
                gameStatusText.textContent = 'Multiplying... Good luck!';
                placeBetBtn.disabled = true;
                if (currentBetAmount > 0 && !cashedOutThisRound) {
                    cashOutBtn.disabled = false;
                } else {
                    cashOutBtn.disabled = true;
                }
                roundResultInfo.textContent = "";
                roundResultInfo.className = 'message-text';
                break;
            case 'CRASHED':
                gameStatusText.textContent = `CRASHED @ ${parseFloat(gameState.crashPoint).toFixed(2)}x`;
                updateMultiplierDisplay(gameState.crashPoint, "crashed");
                placeBetBtn.disabled = true;
                cashOutBtn.disabled = true;
                break;
        }
    });

    socket.on('timerUpdate', (data) => {
        if (gameStatusText.textContent.startsWith('Next round in')) {
             gameStatusText.textContent = `Next round in ${data.timeToNextRound}s. Place your bets!`;
        }
    });

    socket.on('multiplierUpdate', (data) => {
        if (document.hidden) return;
        updateMultiplierDisplay(data.multiplier, "running");
        updateRocketPosition(data.multiplier, "RUNNING");
        if (currentBetAmount > 0 && !cashedOutThisRound && !cashOutBtn.disabled) {
             cashOutBtn.textContent = `Cash Out @ ${(currentBetAmount * data.multiplier).toFixed(2)}`;
        }
    });

    placeBetBtn.addEventListener('click', () => {
        const amount = parseFloat(betAmountInput.value);
        if (isNaN(amount) || amount <= 0) {
            errorMessageDisplay.textContent = 'Please enter a valid bet amount.';
            setTimeout(() => { errorMessageDisplay.textContent = ''; }, 3000);
            return;
        }

        let autoTargetPayload = null;
        if (currentAutoCashoutTarget) {
            autoTargetPayload = currentAutoCashoutTarget;
        } else if (autoCashoutInput.value !== "" && (isNaN(parseFloat(autoCashoutInput.value)) || parseFloat(autoCashoutInput.value) <= 1.00) ){
            errorMessageDisplay.textContent = 'Invalid auto cashout value. Betting without auto cashout.';
            setTimeout(() => { errorMessageDisplay.textContent = ''; }, 4000);
            autoCashoutInput.value = "";
        }

        socket.emit('placeBet', {
            amount: amount,
            autoCashoutAt: autoTargetPayload
        });
        errorMessageDisplay.textContent = '';
    });

    socket.on('betPlacedAck', (data) => {
        currentBetAmount = data.amount;
        playerBalanceDisplay.textContent = parseFloat(data.balance).toFixed(2);
        currentAutoCashoutTarget = data.autoCashoutAt ? parseFloat(data.autoCashoutAt) : null;
        if (currentAutoCashoutTarget) {
            autoCashoutInput.value = currentAutoCashoutTarget.toFixed(2);
        } else {
        }
        updateAutoCashoutStatus();
        placeBetBtn.disabled = true;
        errorMessageDisplay.textContent = '';
    });

    cashOutBtn.addEventListener('click', () => { socket.emit('cashOut'); });

    socket.on('cashedOutAck', (data) => {
        cashedOutThisRound = true;
        cashOutBtn.disabled = true;
        cashOutBtn.textContent = "Cashed Out!";
        currentBetStatus.textContent = `Cashed out at ${parseFloat(data.multiplier).toFixed(2)}x for ${parseFloat(data.potentialWinnings).toFixed(2)}`;
        errorMessageDisplay.textContent = '';
    });

    socket.on('roundResult', (data) => {
        if (data.sid !== mySID && socket.id !== data.sid) return;

        playerBalanceDisplay.textContent = parseFloat(data.balance).toFixed(2);
        roundResultInfo.className = 'message-text';
        if (data.won) {
            roundResultInfo.textContent = `You won ${parseFloat(data.winnings).toFixed(2)} at ${parseFloat(data.payout).toFixed(2)}x!`;
            roundResultInfo.classList.add('win');
        } else {
            if (data.hasOwnProperty('currentBetAmount') && data.currentBetAmount > 0 && !cashedOutThisRound) {
                 roundResultInfo.textContent = `You lost your ${parseFloat(data.currentBetAmount).toFixed(2)} bet.`;
                 roundResultInfo.classList.add('loss');
            }
        }
        currentBetAmount = 0;
        cashedOutThisRound = false;
    });

    socket.on('errorMessage', (data) => {
        errorMessageDisplay.textContent = data.message;
        setTimeout(() => { errorMessageDisplay.textContent = ''; }, 4000);
    });

    function initTrailCanvas() {
        if (!trailCanvas || !trailCtx || !flightPathContainer) return;
        trailCanvas.width = flightPathContainer.offsetWidth;
        trailCanvas.height = flightPathContainer.offsetHeight;
        trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
        trailParticles = [];
    }
    if (trailCanvas) { window.addEventListener('resize', initTrailCanvas); initTrailCanvas(); }

    function addTrailParticle(x, y) {
        if (!trailCtx || !gameRunning) return;
        const count = 3;
        for (let i = 0; i < count; i++) {
            trailParticles.push({
                x: x, y: y, size: Math.random() * 2.5 + 1,
                speedX: (Math.random() - 0.5) * 1.2, speedY: Math.random() * 0.8 + 0.4,
                life: Math.random() * 25 + 15,
                color: `rgba(255, ${Math.floor(Math.random()*100 + 150)}, 0, ${Math.random()*0.4 + 0.2})`
            });
        }
    }

    function drawAndUpdateTrail() {
        if (!trailCtx) return;
        trailCtx.clearRect(0, 0, trailCanvas.width, trailCanvas.height);
        for (let i = trailParticles.length - 1; i >= 0; i--) {
            let p = trailParticles[i];
            trailCtx.beginPath(); trailCtx.fillStyle = p.color;
            trailCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2, false); trailCtx.fill();
            p.x += p.speedX; p.y += p.speedY; p.life--; p.size *= 0.96;
            if (p.life <= 0 || p.size < 0.3) { trailParticles.splice(i, 1); }
        }
    }

    function updateRocketPosition(multiplier, status) {
        if (!rocketWrapper || !flightPathContainer) return;
        const containerHeight = flightPathContainer.offsetHeight;
        const rocketActualHeight = rocketWrapper.offsetHeight || 83;
        let targetBottom = 0;
        rocketWrapper.classList.remove('crashed', 'flying');

        if (status === 'RUNNING') {
            gameRunning = true; rocketWrapper.classList.add('flying');
            const maxMultiplierForPath = 30, minMultiplierForPath = 1.00; let progress = 0;
            if (multiplier > minMultiplierForPath) {
                const logBase = 1.25, logMax = Math.log(maxMultiplierForPath) / Math.log(logBase);
                const logCurrent = Math.log(Math.max(minMultiplierForPath, multiplier)) / Math.log(logBase);
                progress = Math.min(1, logCurrent / logMax);
            }
            targetBottom = progress * (containerHeight - rocketActualHeight * 0.85);
            targetBottom = Math.min(targetBottom, containerHeight - rocketActualHeight * 0.85);
            targetBottom = Math.max(0, targetBottom);
            const rocketVisualCenterX = flightPathContainer.offsetWidth / 2;
            const rocketVisualFlameY = containerHeight - targetBottom - (rocketActualHeight * 0.05);
            addTrailParticle(rocketVisualCenterX, rocketVisualFlameY);
        } else if (status === 'WAITING') {
            gameRunning = false; targetBottom = 0;
            rocketWrapper.style.transform = 'translateX(-50%) rotate(-30deg)';
            if (rocketWrapper.classList.contains('crashed')) { rocketWrapper.style.opacity = '1'; }
            initTrailCanvas();
        } else if (status === 'CRASHED') {
            gameRunning = false; rocketWrapper.classList.add('crashed');
            const currentBottomStyle = window.getComputedStyle(rocketWrapper).bottom;
            targetBottom = parseFloat(currentBottomStyle) || 0;
        }
        if (!rocketWrapper.classList.contains('crashed') || status !== 'CRASHED') {
             rocketWrapper.style.bottom = `${targetBottom}px`;
        }
        if (status === 'RUNNING' && !rocketWrapper.classList.contains('crashed')) {
             rocketWrapper.style.transform = 'translateX(-50%) rotate(0deg)';
        } else if (status === 'WAITING') {
             rocketWrapper.style.transform = 'translateX(-50%) rotate(-30deg)';
        }
    }

    function animationLoop() { drawAndUpdateTrail(); requestAnimationFrame(animationLoop); }
    if (trailCtx) { animationLoop(); }

    function updateMultiplierDisplay(multiplier, status = "running") {
        multiplierValueDisplay.textContent = parseFloat(multiplier).toFixed(2) + 'x';
        multiplierValueDisplay.classList.remove('multiplier-waiting', 'multiplier-low', 'multiplier-medium', 'multiplier-high', 'multiplier-very-high', 'multiplier-crashed');
        if (status === "crashed") { multiplierValueDisplay.classList.add('multiplier-crashed'); }
        else if (status === "waiting") { multiplierValueDisplay.classList.add('multiplier-waiting'); }
        else {
            if (multiplier < 1.01) multiplierValueDisplay.classList.add('multiplier-waiting');
            else if (multiplier < 2) multiplierValueDisplay.classList.add('multiplier-low');
            else if (multiplier < 5) multiplierValueDisplay.classList.add('multiplier-medium');
            else if (multiplier < 10) multiplierValueDisplay.classList.add('multiplier-high');
            else multiplierValueDisplay.classList.add('multiplier-very-high');
        }
    }
    function updateCrashHistory(history) {
        crashHistoryList.innerHTML = '';
        history.forEach(crashPoint => {
            const li = document.createElement('li');
            const point = parseFloat(crashPoint).toFixed(2);
            li.textContent = `${point}x`;
            if (crashPoint < 1.5) li.classList.add('history-low');
            else if (crashPoint < 3) li.classList.add('history-mid');
            else if (crashPoint < 10) li.classList.add('history-high');
            else li.classList.add('history-insane');
            crashHistoryList.appendChild(li);
        });
    }
});
