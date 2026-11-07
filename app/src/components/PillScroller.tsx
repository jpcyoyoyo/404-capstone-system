import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface Props {
  children: React.ReactNode;
  /** Changes when the selection changes; the selected (.active) pill is scrolled into view. */
  activeKey?: string | number;
  style?: React.CSSProperties;
}

/**
 * A row of pills that scrolls sideways without a scrollbar. A soft fade shows on the side where
 * more pills are hidden. Touch: swipe. Mouse: the wheel moves the row, or click and drag it
 * (a drag is not taken as a click on a pill). The selected pill is kept in view.
 */
const PillScroller: React.FC<Props> = ({ children, activeKey, style }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ l: false, r: false });
  const first = useRef(true);
  const lastW = useRef(0);

  /** Scroll so the selected (.active) pill is fully visible. */
  const reveal = (smooth: boolean) => {
    const el = ref.current; if (!el || !el.clientWidth) return;
    const a = el.querySelector<HTMLElement>('.active'); if (!a) return;
    const left = a.offsetLeft; const right = left + a.offsetWidth;
    let to: number | null = null;
    if (left < el.scrollLeft + 8) to = left - 24;
    else if (right > el.scrollLeft + el.clientWidth - 8) to = right - el.clientWidth + 24;
    if (to !== null) el.scrollTo({ left: Math.max(0, to), behavior: smooth ? 'smooth' : 'auto' });
  };

  const update = () => {
    const el = ref.current; if (!el) return;
    const l = el.scrollLeft > 1;
    const r = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade(f => (f.l === l && f.r === r ? f : { l, r }));
  };

  useLayoutEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // A page sliding in has no width yet: reveal the selected pill once it is laid out.
    const ro = new ResizeObserver(() => {
      update();
      if (el.clientWidth !== lastW.current) { lastW.current = el.clientWidth; reveal(false); }
    });
    ro.observe(el);
    return () => ro.disconnect();
     
  }, []);
  useLayoutEffect(update);

  // Keep the selected pill in view whenever the selection changes.
  useEffect(() => {
    reveal(!first.current);
    first.current = false;
     
  }, [activeKey]);

  // Mouse wheel moves the row sideways, but only while the row can still move that way.
  useEffect(() => {
    const el = ref.current; if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      const before = el.scrollLeft;
      el.scrollLeft = before + e.deltaY;
      if (el.scrollLeft !== before) e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Mouse click-and-drag.
  const drag = useRef({ down: false, moved: false, x: 0, left: 0, id: 0 });
  const onDown = (e: React.PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag.current = { down: true, moved: false, x: e.clientX, left: ref.current!.scrollLeft, id: e.pointerId };
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d.down) return;
    const dx = e.clientX - d.x;
    if (!d.moved && Math.abs(dx) > 5) {
      d.moved = true;
      ref.current!.classList.add('dragging');
      try { ref.current!.setPointerCapture(d.id); } catch { /* gone */ }
    }
    if (d.moved) ref.current!.scrollLeft = d.left - dx;
  };
  const onUp = () => {
    const d = drag.current; if (!d.down) return;
    d.down = false;
    ref.current?.classList.remove('dragging');
  };
  // Swallow the click that ends a drag, so the pill under the mouse isn't selected.
  const onClickCapture = (e: React.MouseEvent) => {
    if (drag.current.moved) { e.stopPropagation(); e.preventDefault(); drag.current.moved = false; }
  };

  return (
    <div ref={ref} className={`sg-pill-scroll${fade.l ? ' fade-l' : ''}${fade.r ? ' fade-r' : ''}`} style={style}
      onScroll={update} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onClickCapture={onClickCapture}>
      {children}
    </div>
  );
};

export default PillScroller;
