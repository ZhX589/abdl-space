export const EMBED_JS = `/**
 * ABDL-Space Captcha Embeddable SDK v2
 *
 * 安全增强:
 * - 节点位置随机化（从后端获取）
 * - 10秒超时重置 + 倒计时
 * - 行为分析采集（鼠标轨迹/点击间隔/悬停时间）
 * - 隐蔽上下文回传
 * - 前端防篡改校验
 */
(function () {
  'use strict';

  const API_BASE = 'https://api.abdl-space.top';
  const VERSION = '2.0.0';

  /* ---- 防篡改：完整性哈希 ---- */
  const _integrity = (() => {
    // 简单的代码指纹，用于检测是否被篡改
    const src = document.currentScript?.src || '';
    const nonce = Math.random().toString(36).slice(2, 8);
    return { src, nonce, ts: Date.now() };
  })();

  /* ---- 样式注入 ---- */
  function injectStyles() {
    if (document.getElementById('abdl-captcha-style')) return;
    const style = document.createElement('style');
    style.id = 'abdl-captcha-style';
    style.textContent = \`
      .abdl-captcha-wrap {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        max-width: 400px;
        user-select: none;
        position: relative;
      }
      .abdl-captcha-canvas {
        width: 100%;
        height: auto;
        border-radius: 12px;
        border: 1.5px solid #e0e0e0;
        cursor: crosshair;
        touch-action: none;
        display: block;
      }
      .abdl-captcha-bar {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        font-size: 12px;
        color: #666;
      }
      .abdl-captcha-bar .abdl-status { flex: 1; }
      .abdl-captcha-bar .abdl-status.ok { color: #06d6a0; font-weight: 600; }
      .abdl-captcha-bar .abdl-status.err { color: #ef476f; }
      .abdl-captcha-bar .abdl-status.locked { color: #ef476f; font-weight: 600; }
      .abdl-captcha-bar button {
        padding: 3px 10px;
        border-radius: 6px;
        border: 1px solid #ddd;
        background: #fff;
        font-size: 11px;
        cursor: pointer;
        color: #333;
      }
      .abdl-captcha-bar button:hover { border-color: #4361ee; color: #4361ee; }
      .abdl-captcha-powered {
        text-align: right;
        font-size: 10px;
        color: #aaa;
        margin-top: 4px;
      }
      .abdl-captcha-powered a { color: #4361ee; text-decoration: none; }
      .abdl-captcha-timer {
        position: absolute;
        top: 8px;
        right: 8px;
        font-size: 11px;
        color: #999;
        background: rgba(0,0,0,0.05);
        padding: 2px 8px;
        border-radius: 10px;
        font-variant-numeric: tabular-nums;
      }
      .abdl-captcha-timer.warn { color: #ef476f; background: rgba(239,71,111,0.1); font-weight: 600; }
      .abdl-captcha-progress {
        position: absolute;
        bottom: 0;
        left: 0;
        height: 2px;
        background: #4361ee;
        border-radius: 0 0 12px 12px;
        transition: width 0.1s linear;
      }
      .abdl-captcha-progress.warn { background: #ef476f; }
      [data-theme="dark"] .abdl-captcha-canvas { border-color: #333; }
      [data-theme="dark"] .abdl-captcha-bar { color: #999; }
      [data-theme="dark"] .abdl-captcha-bar button { background: #222; border-color: #444; color: #ccc; }
      [data-theme="dark"] .abdl-captcha-timer { background: rgba(255,255,255,0.08); color: #777; }
    \`;
    document.head.appendChild(style);
  }

  /* ---- 粒子 ---- */
  class Particle {
    constructor(x, y, color, speed, life, size) {
      this.x = x; this.y = y;
      const a = Math.random() * Math.PI * 2, v = speed * (0.5 + Math.random());
      this.vx = Math.cos(a) * v; this.vy = Math.sin(a) * v;
      this.life = life; this.maxLife = life; this.color = color; this.size = size;
    }
    update() { this.x += this.vx; this.y += this.vy; this.vy += 0.04; this.vx *= 0.99; this.vy *= 0.99; this.life--; }
    draw(ctx) {
      const alpha = Math.max(0, this.life / this.maxLife);
      ctx.globalAlpha = alpha; ctx.fillStyle = this.color;
      ctx.beginPath(); ctx.arc(this.x, this.y, this.size * alpha, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
    get dead() { return this.life <= 0; }
  }

  class BgParticle {
    constructor(w, h) {
      this.x = Math.random() * w; this.y = Math.random() * h;
      this.r = 1 + Math.random() * 1.5; this.speed = 0.15 + Math.random() * 0.25;
      this.angle = Math.random() * Math.PI * 2; this.alpha = 0.15 + Math.random() * 0.2;
      this.w = w; this.h = h; this.hue = Math.random() > 0.5 ? 200 : 340;
    }
    update() {
      this.x += Math.cos(this.angle) * this.speed;
      this.y += Math.sin(this.angle) * this.speed;
      this.angle += (Math.random() - 0.5) * 0.03;
      if (this.x < -10) this.x = this.w + 10; if (this.x > this.w + 10) this.x = -10;
      if (this.y < -10) this.y = this.h + 10; if (this.y > this.h + 10) this.y = -10;
    }
    draw(ctx) {
      ctx.globalAlpha = this.alpha;
      ctx.fillStyle = \`hsl(\${this.hue}, 60%, 55%)\`;
      ctx.beginPath(); ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ---- 行为采集器 ---- */
  class BehaviorCollector {
    constructor(canvas) {
      this.canvas = canvas;
      this.mouse轨迹 = [];       // [x, y, timestamp]
      this.clickTimes = [];      // 每次点击的时间戳
      this.hoverDurations = {};  // nodeId -> 累计悬停 ms
      this.hoverStart = {};      // nodeId -> 开始悬停时间
      this.startTime = Date.now();
      this.touchUsed = false;

      this._onMove = this._onMove.bind(this);
      this._onTouch = this._onTouch.bind(this);
      canvas.addEventListener('pointermove', this._onMove, { passive: true });
      canvas.addEventListener('touchstart', this._onTouch, { passive: true });
    }

    _onMove(e) {
      // 每 3 个点采样一次，减少数据量
      if (this.mouse轨迹.length < 200 && Math.random() < 0.33) {
        this.mouse轨迹.push([Math.round(e.clientX), Math.round(e.clientY), Date.now() - this.startTime]);
      }
    }

    _onTouch() { this.touchUsed = true; }

    recordClick() { this.clickTimes.push(Date.now() - this.startTime); }

    recordHoverStart(nodeId) { this.hoverStart[nodeId] = Date.now(); }

    recordHoverEnd(nodeId) {
      if (this.hoverStart[nodeId]) {
        const dur = Date.now() - this.hoverStart[nodeId];
        this.hoverDurations[nodeId] = (this.hoverDurations[nodeId] || 0) + dur;
        delete this.hoverStart[nodeId];
      }
    }

    getData() {
      return {
        轨迹: this.mouse轨迹,
        clickTimes: this.clickTimes,
        hoverDurations: Object.values(this.hoverDurations),
        totalTime: Date.now() - this.startTime,
        touchUsed: this.touchUsed,
        screen: \`\${screen.width}x\${screen.height}\`,
        tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    }

    destroy() {
      this.canvas.removeEventListener('pointermove', this._onMove);
      this.canvas.removeEventListener('touchstart', this._onTouch);
    }
  }

  /* ---- 渲染器 ---- */
  class CaptchaRenderer {
    constructor(container, options) {
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('ABDLCaptcha: container not found');
      this.options = options;
      this.apiKey = options.apiKey;
      this.apiBase = options.apiBase || API_BASE;
      this.onSuccess = options.onSuccess || (() => {});
      this.onError = options.onError || (() => {});
      this.sessionId = null;
      this.nodes = [];           // 从后端获取的随机位置
      this.correctOrder = [];
      this.ctx = null;           // 隐蔽上下文 token
      this.timeoutMs = 10000;
      this.userSequence = [];
      this.successfulEdges = [];
      this.attemptCount = 0;
      this.isVerified = false;
      this.cooldownUntil = 0;
      this.hoveredNode = null;
      this.isDragging = false;
      this.lastActiveNodeId = null;
      this.particles = [];
      this.bgParticles = [];
      this.bgInit = false;
      this.edgeDashOffset = 0;
      this.nodeScales = {};
      this.shakeFrames = 0;
      this.successBurst = false;

      // 超时相关
      this.timerStart = 0;
      this.timerExpired = false;
      this.countdownInterval = null;

      // 行为采集
      this.behavior = null;

      // 防篡改
      this._fingerprint = this._calcFingerprint();

      injectStyles();
      this.buildUI();
      this.bindEvents();
      this.fetchChallenge();
    }

    /** 计算运行时指纹（简单的防篡改） */
    _calcFingerprint() {
      const ua = navigator.userAgent;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const lang = navigator.language;
      let hash = 0;
      const str = ua + tz + lang + VERSION;
      for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) - hash) + str.charCodeAt(i);
        hash |= 0;
      }
      return hash.toString(36);
    }

    buildUI() {
      this.container.innerHTML = '';
      this.container.classList.add('abdl-captcha-wrap');

      this.canvas = document.createElement('canvas');
      this.canvas.width = 550; this.canvas.height = 260;
      this.canvas.className = 'abdl-captcha-canvas';
      this.ctxCanvas = this.canvas.getContext('2d');
      this.container.appendChild(this.canvas);

      // 倒计时
      this.timerEl = document.createElement('div');
      this.timerEl.className = 'abdl-captcha-timer';
      this.timerEl.textContent = '';
      this.container.appendChild(this.timerEl);

      // 进度条
      this.progressEl = document.createElement('div');
      this.progressEl.className = 'abdl-captcha-progress';
      this.progressEl.style.width = '0%';
      this.container.appendChild(this.progressEl);

      const bar = document.createElement('div');
      bar.className = 'abdl-captcha-bar';

      this.statusEl = document.createElement('span');
      this.statusEl.className = 'abdl-status';
      this.statusEl.textContent = '加载中...';
      bar.appendChild(this.statusEl);

      this.attemptsEl = document.createElement('span');
      bar.appendChild(this.attemptsEl);

      this.resetBtn = document.createElement('button');
      this.resetBtn.type = 'button';
      this.resetBtn.textContent = '重置';
      bar.appendChild(this.resetBtn);

      this.container.appendChild(bar);

      const powered = document.createElement('div');
      powered.className = 'abdl-captcha-powered';
      powered.innerHTML = \`Protected by <a href="https://abdl-space.top" target="_blank">ABDL-Space</a>\`;
      this.container.appendChild(powered);

      this.drawLoop();
    }

    bindEvents() {
      this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', () => { this.isDragging = false; this.lastActiveNodeId = null; });
      this.canvas.addEventListener('pointerleave', () => {
        this.isDragging = false; this.lastActiveNodeId = null;
        if (this.hoveredNode) { this.behavior?.recordHoverEnd(this.hoveredNode); }
        this.hoveredNode = null;
      });
      this.resetBtn.addEventListener('click', () => this.reset());
    }

    async fetchChallenge() {
      this.setStatus('正在加载...');
      try {
        const res = await fetch(\`\${this.apiBase}/api/v1/captcha/create\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${this.apiKey}\` },
          body: JSON.stringify({ type: 'quantum' }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create challenge');

        this.sessionId = data.session_id;
        this.nodes = data.challenge.nodes || [];  // 随机位置
        this.correctOrder = data.challenge.order || [];
        this.ctx = data.challenge.ctx || '';       // 隐蔽上下文
        this.timeoutMs = data.challenge.timeoutMs || 10000;
        this.userSequence = []; this.successfulEdges = [];
        this.attemptCount = 0; this.isVerified = false;
        this.successBurst = false; this.nodeScales = {};
        this.timerExpired = false;

        // 初始化行为采集
        if (this.behavior) this.behavior.destroy();
        this.behavior = new BehaviorCollector(this.canvas);

        this.setStatus('按高亮顺序点击节点');
        this.updateAttempts();
        this.startTimer();
      } catch (err) {
        this.setStatus(err.message, 'err');
        this.onError(err);
      }
    }

    startTimer() {
      this.timerStart = Date.now();
      if (this.countdownInterval) clearInterval(this.countdownInterval);
      this.countdownInterval = setInterval(() => {
        if (this.isVerified || this.timerExpired) { clearInterval(this.countdownInterval); return; }
        const elapsed = Date.now() - this.timerStart;
        const remaining = Math.max(0, this.timeoutMs - elapsed);
        const secs = Math.ceil(remaining / 1000);

        this.timerEl.textContent = secs <= 5 ? \`\${secs}s\` : '';
        this.timerEl.className = 'abdl-captcha-timer' + (secs <= 5 ? ' warn' : '');

        const pct = (elapsed / this.timeoutMs) * 100;
        this.progressEl.style.width = Math.min(100, pct) + '%';
        this.progressEl.className = 'abdl-captcha-progress' + (secs <= 5 ? ' warn' : '');

        if (remaining <= 0) {
          clearInterval(this.countdownInterval);
          this.timerExpired = true;
          this.setStatus('超时，正在重置...', 'err');
          setTimeout(() => this.fetchChallenge(), 800);
        }
      }, 200);
    }

    setStatus(text, cls) {
      this.statusEl.textContent = text;
      this.statusEl.className = 'abdl-status' + (cls ? ' ' + cls : '');
    }

    updateAttempts() {
      this.attemptsEl.textContent = \`尝试: \${this.attemptCount}/\${5}\`;
    }

    reset() {
      if (this.isVerified) return;
      this.userSequence = []; this.successfulEdges = [];
      this.isDragging = false; this.nodeScales = {};
      this.timerExpired = false;
      this.timerStart = Date.now();
      this.setStatus('已重置，按高亮顺序点击');
    }

    getNodeUnder(cx, cy) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (cx - rect.left) * (this.canvas.width / rect.width);
      const y = (cy - rect.top) * (this.canvas.height / rect.height);
      for (const n of this.nodes) if (Math.hypot(n.x - x, n.y - y) < 28) return n.id;
      return null;
    }

    onPointerDown(e) {
      if (this.isVerified || this.attemptCount >= 5 || this.timerExpired) return;
      if (this.cooldownUntil && Date.now() < this.cooldownUntil) return;
      if (!this.correctOrder.length) return;
      const hit = this.getNodeUnder(e.clientX, e.clientY);
      if (hit && !this.userSequence.includes(hit)) {
        this.isDragging = true; this.lastActiveNodeId = hit;
        this.behavior?.recordClick();
        this.tryAdd(hit);
      } else if (!hit) {
        this.complete(false);
      }
    }

    onPointerMove(e) {
      const prevHover = this.hoveredNode;
      this.hoveredNode = this.getNodeUnder(e.clientX, e.clientY);
      // 悬停追踪
      if (prevHover !== this.hoveredNode) {
        if (prevHover) this.behavior?.recordHoverEnd(prevHover);
        if (this.hoveredNode) this.behavior?.recordHoverStart(this.hoveredNode);
      }
      if (!this.isDragging || this.isVerified || this.attemptCount >= 5) return;
      const hit = this.hoveredNode;
      if (hit && hit !== this.lastActiveNodeId && !this.userSequence.includes(hit)) {
        this.tryAdd(hit); this.lastActiveNodeId = hit;
      }
    }

    tryAdd(nodeId) {
      if (this.isVerified || this.timerExpired) return;
      if (this.cooldownUntil && Date.now() < this.cooldownUntil) return;
      if (this.userSequence.includes(nodeId)) return;

      if (nodeId === this.correctOrder[this.userSequence.length]) {
        const prev = this.userSequence.length > 0 ? this.userSequence[this.userSequence.length - 1] : null;
        this.userSequence.push(nodeId);
        if (prev) this.successfulEdges.push({ from: prev, to: nodeId });
        const node = this.nodes.find(n => n.id === nodeId);
        if (node) this.spawnHit(node.x, node.y);
        this.nodeScales[nodeId] = 1.4;
        if (this.userSequence.length === this.correctOrder.length) this.complete(true);
      } else {
        this.complete(false);
      }
    }

    spawnHit(x, y) {
      const colors = ['#A8D8F0', '#FFB7C5', '#fff', '#7BC67E', '#F0C040'];
      for (let i = 0; i < 18; i++) this.particles.push(new Particle(x, y, colors[i % colors.length], 2.5 + Math.random() * 2, 30 + Math.random() * 20, 2 + Math.random() * 2.5));
    }

    spawnBurst() {
      const cx = this.canvas.width / 2, cy = this.canvas.height / 2;
      const colors = ['#A8D8F0', '#FFB7C5', '#7BC67E', '#F0C040', '#fff'];
      for (let i = 0; i < 50; i++) this.particles.push(new Particle(cx, cy, colors[i % colors.length], 3 + Math.random() * 4, 50 + Math.random() * 30, 2.5 + Math.random() * 3));
    }

    complete(success) {
      if (this.isVerified) return;
      if (success) {
        this.isVerified = true;
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        this.setStatus('验证通过，正在提交...', 'ok');
        this.submitAnswer();
        return;
      }
      this.attemptCount++;
      this.updateAttempts();
      this.shakeFrames = 12;

      if (this.attemptCount >= 5) {
        if (this.countdownInterval) clearInterval(this.countdownInterval);
        this.setStatus('已锁定，请稍后重试', 'locked');
        this.onError(new Error('Locked: too many attempts'));
        return;
      }
      this.setStatus('顺序错误，请重试', 'err');
      this.cooldownUntil = Date.now() + 2000;
      setTimeout(() => {
        if (!this.isVerified && !this.timerExpired) {
          this.userSequence = []; this.successfulEdges = []; this.nodeScales = {};
          this.setStatus('按高亮顺序点击节点');
        }
      }, 2000);
    }

    async submitAnswer() {
      try {
        const behaviorData = this.behavior ? this.behavior.getData() : null;
        const res = await fetch(\`\${this.apiBase}/api/v1/captcha/check\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': \`Bearer \${this.apiKey}\` },
          body: JSON.stringify({
            session_id: this.sessionId,
            answer: this.userSequence.join(','),
            behavior: behaviorData,
            ctx: this.ctx,
            _fp: this._fingerprint,
            _v: VERSION,
          }),
        });
        const data = await res.json();
        if (data.verified && data.token) {
          this.setStatus('✓ 验证成功', 'ok');
          this.onSuccess(data.token);
        } else if (data.locked) {
          this.setStatus('已锁定', 'locked');
          this.onError(new Error('Locked'));
        } else {
          this.isVerified = false;
          this.userSequence = []; this.successfulEdges = []; this.nodeScales = {};
          this.attemptCount = data.attempts_left ? 5 - data.attempts_left : this.attemptCount;
          this.updateAttempts();
          this.setStatus(\`服务端验证失败，剩余 \${data.attempts_left} 次\`, 'err');
          setTimeout(() => { if (!this.timerExpired) this.setStatus('按高亮顺序点击节点'); }, 1500);
        }
      } catch (err) {
        this.setStatus('网络错误', 'err');
        this.onError(err);
      }
    }

    drawLoop() {
      this.draw();
      requestAnimationFrame(() => this.drawLoop());
    }

    draw() {
      const ctx = this.ctxCanvas, st = this, W = this.canvas.width, H = this.canvas.height;
      if (!st.bgInit) { for (let i = 0; i < 20; i++) st.bgParticles.push(new BgParticle(W, H)); st.bgInit = true; }

      let sx = 0, sy = 0;
      if (st.shakeFrames > 0) { sx = (Math.random() - 0.5) * 6; sy = (Math.random() - 0.5) * 4; st.shakeFrames--; }

      ctx.save(); ctx.translate(sx, sy);
      ctx.clearRect(-10, -10, W + 20, H + 20);

      for (const p of st.bgParticles) { p.update(); p.draw(ctx); }

      ctx.strokeStyle = 'rgba(100,120,150,0.12)'; ctx.lineWidth = 0.5;
      st.edgeDashOffset -= 0.3;
      for (let i = 0; i < W; i += 40) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, H); ctx.stroke(); }
      for (let i = 0; i < H; i += 40) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(W, i); ctx.stroke(); }

      for (const edge of st.successfulEdges) {
        const f = st.nodes.find(n => n.id === edge.from), t = st.nodes.find(n => n.id === edge.to);
        if (f && t) {
          const g = ctx.createLinearGradient(f.x, f.y, t.x, t.y);
          g.addColorStop(0, '#A8D8F0'); g.addColorStop(1, '#FFB7C5');
          ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(t.x, t.y);
          ctx.strokeStyle = g; ctx.lineWidth = 3.5; ctx.shadowBlur = 10; ctx.shadowColor = '#A8D8F0';
          ctx.setLineDash([8, 6]); ctx.lineDashOffset = st.edgeDashOffset; ctx.stroke();
          ctx.setLineDash([]); ctx.shadowBlur = 0;
        }
      }

      st.particles = st.particles.filter(p => { p.update(); p.draw(ctx); return !p.dead; });

      const nextId = !st.isVerified && st.userSequence.length < st.correctOrder.length ? st.correctOrder[st.userSequence.length] : null;

      for (const node of st.nodes) {
        const activated = st.userSequence.includes(node.id);
        const isNext = node.id === nextId;
        const hovered = st.hoveredNode === node.id && !activated;
        if (!st.nodeScales[node.id]) st.nodeScales[node.id] = 1;
        const targetScale = activated ? 1.15 : hovered ? 1.08 : 1;
        st.nodeScales[node.id] += (targetScale - st.nodeScales[node.id]) * 0.2;
        const sc = st.nodeScales[node.id];

        ctx.save(); ctx.translate(node.x, node.y); ctx.scale(sc, sc);

        if (isNext) {
          const t = Date.now() / 250, pulse = Math.sin(t) * 0.5 + 0.5;
          ctx.beginPath(); ctx.arc(0, 0, 26 + pulse * 5, 0, Math.PI * 2);
          ctx.strokeStyle = \`rgba(255,183,197,\${0.3 + pulse * 0.4})\`; ctx.lineWidth = 2; ctx.stroke();
          ctx.beginPath(); ctx.arc(0, 0, 32 + pulse * 8, 0, Math.PI * 2);
          ctx.strokeStyle = \`rgba(255,183,197,\${0.08 + pulse * 0.1})\`; ctx.lineWidth = 1; ctx.stroke();
        }
        if (hovered) { ctx.beginPath(); ctx.arc(0, 0, 23, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(168,216,240,0.5)'; ctx.lineWidth = 2.5; ctx.stroke(); }

        ctx.beginPath(); ctx.arc(0, 0, 18, 0, Math.PI * 2);
        ctx.fillStyle = activated ? 'rgba(168,216,240,0.35)' : isNext ? 'rgba(255,183,197,0.2)' : hovered ? 'rgba(168,216,240,0.25)' : 'rgba(100,120,150,0.15)';
        ctx.fill();

        ctx.beginPath(); ctx.arc(0, 0, 12, 0, Math.PI * 2);
        ctx.fillStyle = activated ? '#A8D8F0' : isNext ? '#F0A0B8' : hovered ? '#8CC8E8' : '#718096';
        ctx.fill();

        const blink = 0.7 + Math.sin(Date.now() / 300 + node.x) * 0.3;
        ctx.beginPath(); ctx.arc(0, 0, 5, 0, Math.PI * 2);
        ctx.fillStyle = \`rgba(255,255,255,\${blink})\`; ctx.fill();

        ctx.font = 'bold 15px sans-serif';
        ctx.fillStyle = activated ? '#A8D8F0' : isNext ? '#FFB7C5' : hovered ? '#A8D8F0' : '#A0AAB8';
        ctx.shadowBlur = (activated || isNext || hovered) ? 8 : 2;
        ctx.shadowColor = (activated || isNext) ? '#A8D8F0' : 'transparent';
        ctx.fillText(node.id, -7, -16); ctx.shadowBlur = 0;
        ctx.restore();
      }

      if (st.isVerified && !st.successBurst) { st.successBurst = true; st.verifyTime = Date.now(); st.spawnBurst(); }

      if (st.isVerified) {
        const alpha = Math.min(1, (Date.now() - (st.verifyTime || 0)) / 500);
        ctx.globalAlpha = alpha; ctx.font = 'bold 22px sans-serif'; ctx.fillStyle = '#7BC67E';
        ctx.shadowBlur = 12; ctx.shadowColor = 'rgba(123,198,126,0.5)';
        ctx.fillText('验证通过', W / 2 - 44, H - 14); ctx.shadowBlur = 0; ctx.globalAlpha = 1;
      }

      ctx.restore();
    }
  }

  /* ---- 全局 API ---- */
  window.ABDLCaptcha = {
    render(container, options) {
      return new CaptchaRenderer(container, options);
    },
    version: VERSION,
  };
})();
`;