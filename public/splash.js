globalThis.Web2AppSplash = function (container, options, onDone = () => {}) {
  const frame = document.createElement('div');
  frame.style.cssText = 'position:absolute;inset:0;display:flex;align-items:safe center;justify-content:center;padding:32px 24px;overflow:auto;border-radius:inherit;text-align:center;font-family:system-ui,-apple-system,Segoe UI,sans-serif;';
  frame.style.backgroundColor = options.background;
  frame.style.color = options.foreground;
  frame.setAttribute('role', 'status');
  const content = document.createElement('div');
  content.style.cssText = 'width:100%;max-width:360px;overflow-wrap:anywhere;';
  const tile = document.createElement('div');
  tile.style.cssText = 'display:grid;place-items:center;width:104px;height:104px;margin:0 auto 24px;border:1px solid;border-radius:28px;font-size:36px;font-weight:700;';
  tile.style.background = `${options.foreground}0d`;
  tile.style.borderColor = `${options.foreground}33`;
  tile.setAttribute('aria-hidden', 'true');
  tile.textContent = Array.from(options.title || 'A')[0].toUpperCase();
  if (options.imageDataUrl) {
    const image = document.createElement('img');
    image.src = options.imageDataUrl;
    image.alt = '';
    image.style.cssText = 'display:block;width:72px;height:72px;object-fit:contain;';
    image.onerror = () => { tile.textContent = Array.from(options.title || 'A')[0].toUpperCase(); };
    tile.textContent = '';
    tile.append(image);
  }
  content.append(tile);
  const title = document.createElement('div');
  title.textContent = options.title || 'Nama aplikasi';
  title.style.cssText = 'font-size:28px;font-weight:750;line-height:1.2;letter-spacing:-.04em;';
  content.append(title);
  if (options.subtitle) {
    const subtitle = document.createElement('div');
    subtitle.textContent = options.subtitle;
    subtitle.style.cssText = 'font-size:14px;line-height:1.6;margin-top:10px;';
    content.append(subtitle);
  }
  frame.append(content);
  container.append(frame);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const loops = [];
  const motion = [];
  const loop = (element, frames, duration, delay = 0) => {
    if (!reducedMotion) motion.push(() => element.animate(frames, { duration, delay, iterations: Infinity, easing: 'ease-in-out' }));
  };
  if (options.loader && options.loader !== 'none') {
    const loading = document.createElement('div');
    loading.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:6px;height:28px;margin-top:28px;';
    loading.setAttribute('data-loader', options.loader);
    loading.setAttribute('aria-hidden', 'true');
    if (options.loader === 'dots' || options.loader === 'bars') {
      for (let i = 0; i < 3; i++) {
        const mark = document.createElement('span');
        mark.style.cssText = options.loader === 'dots'
          ? 'width:7px;height:7px;border-radius:50%;background:currentColor;'
          : 'width:5px;height:22px;border-radius:3px;background:currentColor;';
        loading.append(mark);
        const frames = options.loader === 'dots'
          ? [{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }]
          : [{ transform: 'scaleY(.35)' }, { transform: 'scaleY(1)' }, { transform: 'scaleY(.35)' }];
        loop(mark, frames, 900, i * 130);
      }
    } else {
      const mark = document.createElement('span');
      mark.style.cssText = 'width:24px;height:24px;border:2px solid currentColor;border-radius:50%;';
      loading.append(mark);
      if (options.loader === 'spinner') {
        mark.style.borderRightColor = 'transparent';
        loop(mark, [{ transform: 'rotate(0)' }, { transform: 'rotate(360deg)' }], 900);
      } else {
        loop(mark, [{ transform: 'scale(.7)', opacity: .45 }, { transform: 'scale(1)', opacity: 1 }, { transform: 'scale(.7)', opacity: .45 }], 1200);
      }
    }
    content.append(loading);
    const caption = document.createElement('div');
    caption.textContent = 'Menyiapkan aplikasi';
    caption.style.cssText = 'font-size:12px;line-height:1.5;margin-top:10px;';
    content.append(caption);
  }
  const animations = {
    none: [],
    fade: [{ opacity: 0 }, { opacity: 1 }],
    zoom: [{ opacity: 0, transform: 'scale(.75)' }, { opacity: 1, transform: 'scale(1)' }],
    'slide-up': [{ opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'translateY(0)' }],
    bounce: [{ opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'translateY(-12px)', offset: .55 }, { transform: 'translateY(5px)', offset: .8 }, { transform: 'translateY(0)' }],
    rotate: [{ opacity: 0, transform: 'rotate(-12deg) scale(.85)' }, { opacity: 1, transform: 'rotate(0) scale(1)' }],
    pulse: [{ opacity: 0, transform: 'scale(.9)' }, { opacity: 1, transform: 'scale(1)' }],
    flip: [{ opacity: 0, transform: 'perspective(600px) rotateX(-45deg)' }, { opacity: 1, transform: 'perspective(600px) rotateX(0)' }],
  };
  const frames = animations[options.animation] || [];
  if (options.animation === 'pulse') loop(tile, [{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }], 1400);
  let entrance, exit, timer;
  let stopped = false;
  const remove = () => {
    stopped = true;
    document.removeEventListener('visibilitychange', start);
    clearTimeout(timer);
    entrance?.cancel();
    exit?.cancel();
    loops.forEach(animation => animation.cancel());
    frame.remove();
  };
  const start = () => {
    if (stopped || document.visibilityState === 'hidden') return;
    document.removeEventListener('visibilitychange', start);
    motion.forEach(animate => loops.push(animate()));
    entrance = !reducedMotion && frames.length ? content.animate(frames, { duration: Math.min(600, options.duration), easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' }) : null;
    timer = setTimeout(() => {
      if (reducedMotion || options.animation === 'none') {
        remove(); onDone();
      } else {
        exit = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
        // A paused/cancelled exit animation must not leave an overlay blocking the app.
        timer = setTimeout(() => { remove(); onDone(); }, 200);
      }
    }, options.duration);
  };
  if (document.visibilityState === 'hidden') document.addEventListener('visibilitychange', start);
  else start();
  return remove;
};
