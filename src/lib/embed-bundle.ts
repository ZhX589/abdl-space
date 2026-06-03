export const EMBED_JS = `/**
 * ABDL-Space Captcha Embeddable SDK
 *
 * 使用方式:
 * <div id="captcha"></div>
 * <script src="https://api.abdl-space.top/v1/captcha/embed.js"></script>
 * <script>
 *   ABDLCaptcha.render('#captcha', {
 *     apiKey: 'cv_your_key',
 *     onSuccess: (token) => { console.log('Verified:', token); },
 *     onError: (err) => { console.error(err); },
 *   });
 * </script>
 */
(function () {
  'use strict';

  const API_BASE = 'https://api.abdl-space.top';

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
      [data-theme="dark"] .abdl-captcha-canvas { border-color: #333; }
      [data-theme="dark"] .abdl-captcha-bar { color: #999; }
      [data-theme="dark"] .abdl-captcha-bar button { background: #222; border-color: #444; color: #ccc; }
    \`;
    document.head.appendChild(style);
  }

  /* ---- 节点定义 ---- */
  const NODES = [
    { id: 'α', x: 90, y: 65 },
    { id: 'β', x: 270, y: 45 },
    { id: 'γ', x: 440, y: 75 },
    { id: 'δ', x: 400, y: 195 },
    { id: 'ε', x: 140, y: 210 },
  ];
  const MAX_ATTEMPTS = 5;
  const COOLDOWN_MS = 2000;

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

  /* ---- 渲染器 ---- */
  class CaptchaRenderer {
    constructor(container, options) {
      this.container = typeof container === 'string' ? document.querySelector(container) : container;
      if (!this.container) throw new Error('ABDLCaptcha: container not found');
      this.options = options;
      this.apiKey = options.apiKey;
      // apiBase: 内部接口基础路径（如 ''），不走 API Key 鉴权；未设置则走 v1 外部接口
      this.apiBase = options.apiBase !== undefined ? options.apiBase : null;
      this.onSuccess = options.onSuccess || (() => {});
      this.onError = options.onError || (() => {});
      this.sessionId = null;
      this.correctOrder = [];
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

      injectStyles();
      this.buildUI();
      this.bindEvents();
      console.log('[ABDLCaptcha] render called, apiKey:', options.apiKey ? options.apiKey.slice(0, 11) + '...' : 'EMPTY');
      this.fetchChallenge();
    }

    buildUI() {
      this.container.innerHTML = '';
      this.container.classList.add('abdl-captcha-wrap');

      this.canvas = document.createElement('canvas');
      this.canvas.width = 550; this.canvas.height = 260;
      this.canvas.className = 'abdl-captcha-canvas';
      this.ctx = this.canvas.getContext('2d');
      this.container.appendChild(this.canvas);

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
      powered.innerHTML = 'Protected by <a href="https://abdl-space.top" target="_blank">ABDL-Space</a>';
      this.container.appendChild(powered);

      this.drawLoop();
    }

    bindEvents() {
      this.canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
      this.canvas.addEventListener('pointermove', e => this.onPointerMove(e));
      this.canvas.addEventListener('pointerup', () => { this.isDragging = false; this.lastActiveNodeId = null; });
      this.canvas.addEventListener('pointerleave', () => { this.isDragging = false; this.lastActiveNodeId = null; this.hoveredNode = null; });
      this.resetBtn.addEventListener('click', () => this.reset());
    }

    async fetchChallenge() {
      this.setStatus('正在加载...');
      const useInternal = this.apiBase !== null;
      const url = useInternal
        ? \`\${this.apiBase}/api/captcha/challenge\`
        : \`\${API_BASE}/api/v1/captcha/create\`;
      const headers = { 'Content-Type': 'application/json' };
      if (!useInternal) headers['Authorization'] = \`Bearer \${this.apiKey}\`;
      console.log('[ABDLCaptcha] fetchChallenge, apiKey:', this.apiKey ? this.apiKey.slice(0, 11) + '...' : 'EMPTY', 'internal:', useInternal);
      try {
        const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ type: 'quantum' }) });
        const data = await res.json();
        console.log('[ABDLCaptcha] create response:', res.status, data);
        if (!res.ok) throw new Error(data.error || 'Failed to create challenge');
        this.sessionId = data.session_id;
        this.correctOrder = data.challenge.order || [];
        this.userSequence = []; this.successfulEdges = [];
        this.attemptCount = 0; this.isVerified = false;
        this.successBurst = false; this.nodeScales = {};
        this.setStatus('按高亮顺序点击节点');
        this.updateAttempts();
      } catch (err) {
        this.setStatus(err.message, 'err');
        this.onError(err);
      }
    }

    setStatus(text, cls) {
      this.statusEl.textContent = text;
      this.statusEl.className = 'abdl-status' + (cls ? ' ' + cls : '');
    }

    updateAttempts() {
      this.attemptsEl.textContent = \`尝试: \${this.attemptCount}/\${MAX_ATTEMPTS}\`;
    }

    reset() {
      if (this.isVerified) return;
      this.userSequence = []; this.successfulEdges = [];
      this.isDragging = false; this.nodeScales = {};
      this.setStatus('已重置，按高亮顺序点击');
    }

    getNodeUnder(cx, cy) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (cx - rect.left) * (this.canvas.width / rect.width);
      const y = (cy - rect.top) * (this.canvas.height / rect.height);
      for (const n of NODES) if (Math.hypot(n.x - x, n.y - y) < 28) return n.id;
      return null;
    }

    onPointerDown(e) {
      if (this.isVerified || this.attemptCount >= MAX_ATTEMPTS) return;
      if (this.cooldownUntil && Date.now() < this.cooldownUntil) return;
      if (!this.correctOrder.length) return;
      const hit = this.getNodeUnder(e.clientX, e.clientY);
      if (hit && !this.userSequence.includes(hit)) {
        this.isDragging = true; this.lastActiveNodeId = hit;
        this.tryAdd(hit);
      } else if (!hit) {
        this.complete(false);
      }
    }

    onPointerMove(e) {
      this.hoveredNode = this.getNodeUnder(e.clientX, e.clientY);
      if (!this.isDragging || this.isVerified || this.attemptCount >= MAX_ATTEMPTS) return;
      const hit = this.hoveredNode;
      if (hit && hit !== this.lastActiveNodeId && !this.userSequence.includes(hit)) {
        this.tryAdd(hit); this.lastActiveNodeId = hit;
      }
    }

    tryAdd(nodeId) {
      if (this.isVerified) return;
      if (this.cooldownUntil && Date.now() < this.cooldownUntil) return;
      if (this.userSequence.includes(nodeId)) return;

      if (nodeId === this.correctOrder[this.userSequence.length]) {
        const prev = this.userSequence.length > 0 ? this.userSequence[this.userSequence.length - 1] : null;
        this.userSequence.push(nodeId);
        if (prev) this.successfulEdges.push({ from: prev, to: nodeId });
        const node = NODES.find(n => n.id === nodeId);
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
      console.log('[ABDLCaptcha] complete:', success, 'sequence:', this.userSequence.join(','));
      if (this.isVerified) return;
      if (success) {
        this.isVerified = true;
        this.setStatus('验证通过，正在提交...', 'ok');
        this.submitAnswer();
        return;
      }
      this.attemptCount++;
      this.updateAttempts();
      this.shakeFrames = 12;

      if (this.attemptCount >= MAX_ATTEMPTS) {
        this.setStatus('已锁定，请稍后重试', 'locked');
        this.onError(new Error('Locked: too many attempts'));
        return;
      }
      this.setStatus('顺序错误，请重试', 'err');
      this.cooldownUntil = Date.now() + COOLDOWN_MS;
      setTimeout(() => {
        if (!this.isVerified) {
          this.userSequence = []; this.successfulEdges = []; this.nodeScales = {};
          this.setStatus('按高亮顺序点击节点');
        }
      }, COOLDOWN_MS);
    }

    async submitAnswer() {
      try {
        const useInternal = this.apiBase !== null;
        const url = useInternal
          ? \`\${this.apiBase}/api/captcha/verify\`
          : \`\${API_BASE}/api/v1/captcha/check\`;
        const headers = { 'Content-Type': 'application/json' };
        if (!useInternal) headers['Authorization'] = \`Bearer \${this.apiKey}\`;
        console.log('[ABDLCaptcha] submitAnswer:', { sessionId: this.sessionId, answer: this.userSequence.join(','), hasApiKey: !!this.apiKey, internal: useInternal });
        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({ session_id: this.sessionId, answer: this.userSequence.join(',') }),
        });
        const data = await res.json();
        console.log('[ABDLCaptcha] check response:', data);
        if ((data.verified || data.success) && data.token) {
          this.setStatus('✓ 验证成功', 'ok');
          this.onSuccess(data.token);
        } else if (data.locked) {
          this.setStatus('已锁定', 'locked');
          this.onError(new Error('Locked'));
        } else {
          this.isVerified = false;
          this.userSequence = []; this.successfulEdges = []; this.nodeScales = {};
          this.attemptCount = data.attempts_left ? MAX_ATTEMPTS - data.attempts_left : this.attemptCount;
          this.updateAttempts();
          this.setStatus(\`服务端验证失败，剩余 \${data.attempts_left} 次\`, 'err');
          setTimeout(() => this.setStatus('按高亮顺序点击节点'), 1500);
        }
      } catch (err) {
        console.error('[ABDLCaptcha] submitAnswer error:', err);
        this.setStatus('网络错误', 'err');
        this.onError(err);
      }
    }

    drawLoop() {
      this.draw();
      requestAnimationFrame(() => this.drawLoop());
    }

    draw() {
      const ctx = this.ctx, st = this, W = this.canvas.width, H = this.canvas.height;
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
        const f = NODES.find(n => n.id === edge.from), t = NODES.find(n => n.id === edge.to);
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

      for (const node of NODES) {
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
    /**
     * 渲染验证码组件
     * @param {string|Element} container - CSS 选择器或 DOM 元素
     * @param {Object} options
     * @param {string} options.apiKey - Captcha API Key (cv_xxxx)
     * @param {function} options.onSuccess - 验证成功回调 (token) => {}
     * @param {function} [options.onError] - 错误回调 (error) => {}
     * @returns {CaptchaRenderer} 实例
     */
    render(container, options) {
      return new CaptchaRenderer(container, options);
    },
  };
})();`;
