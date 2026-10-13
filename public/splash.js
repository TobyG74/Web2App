globalThis.Web2AppSplash = function (container, options, onDone = () => {}) {
  const frame = document.createElement('div');
  frame.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;overflow:auto;text-align:center;font-family:Arial,Helvetica,sans-serif;';
  frame.style.backgroundColor = options.background;
  frame.style.color = options.foreground;
  frame.setAttribute('role', 'status');
  const content = document.createElement('div');
  content.style.cssText = 'width:100%;max-width:360px;overflow-wrap:anywhere;';
  if (options.imageDataUrl) {
    const image = document.createElement('img');
    image.src = options.imageDataUrl;
    image.alt = '';
    image.style.cssText = 'display:block;width:80px;height:80px;object-fit:contain;margin:0 auto 20px;';
    image.onerror = () => image.remove();
    content.append(image);
  }
  const title = document.createElement('div');
  title.textContent = options.title || 'Nama aplikasi';
  title.style.cssText = 'font-size:24px;font-weight:800;line-height:1.25;';
  content.append(title);
  if (options.subtitle) {
    const subtitle = document.createElement('div');
    subtitle.textContent = options.subtitle;
    subtitle.style.cssText = 'font-size:14px;line-height:1.5;margin-top:12px;';
    content.append(subtitle);
  }
  frame.append(content);
  container.append(frame);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animations = {
    none: [],
    fade: [{ opacity: 0 }, { opacity: 1 }],
    zoom: [{ opacity: 0, transform: 'scale(.75)' }, { opacity: 1, transform: 'scale(1)' }],
    'slide-up': [{ opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'translateY(0)' }],
    bounce: [{ opacity: 0, transform: 'translateY(36px)' }, { opacity: 1, transform: 'translateY(-12px)', offset: .55 }, { transform: 'translateY(5px)', offset: .8 }, { transform: 'translateY(0)' }],
    rotate: [{ opacity: 0, transform: 'rotate(-12deg) scale(.85)' }, { opacity: 1, transform: 'rotate(0) scale(1)' }],
  };
  const frames = animations[options.animation] || [];
  const entrance = !reducedMotion && frames.length ? content.animate(frames, { duration: Math.min(600, options.duration), easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' }) : null;
  let exit;
  const remove = () => {
    clearTimeout(timer);
    entrance?.cancel();
    exit?.cancel();
    frame.remove();
  };
  const timer = setTimeout(() => {
    if (reducedMotion || options.animation === 'none') {
      remove(); onDone();
    } else {
      exit = frame.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: 'forwards' });
      exit.onfinish = () => { remove(); onDone(); };
    }
  }, options.duration);
  return remove;
};
