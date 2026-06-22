import { useCallback, useRef, useState } from "react";

// ===================================================================
// ประเภทข้อมูล
// ===================================================================

export type CtrlMode = "v" | "p";

export interface TelemetryPoint {
  t: number; // ms นับจากเริ่ม session (เวลาสัมพัทธ์ ใช้พล็อตกราฟ)
  pos: number;
  vel: number;
  pwm: number;
  atTarget: boolean;
}

export interface StepResult {
  id: string;
  mode: CtrlMode;
  target: number;
  baseline: number; // ค่าก่อนเปลี่ยน step (ใช้คำนวณ rise time 10-90%)
  kp: number;
  ki: number;
  kd: number;
  startedAt: string; // เวลาจริง (HH:MM:SS) ตอนเริ่ม step
  riseTimeMs: number | null; // null = ยังไปไม่ถึง 90% ภายใน session
  overshootPct: number | null; // % สำหรับโหมด v, null ถ้าไม่มี overshoot
  overshootAbs: number | null; // ค่าจริงที่เกิน target ไป: เมตรถ้า mode p, RPM ถ้า mode v
  settlingTimeMs: number | null; // null = ยังไม่นิ่งภายในเวลาที่เก็บ
  settled: boolean;
  points: TelemetryPoint[]; // เก็บไว้พล็อตกราฟย้อนหลังได้ถ้าต้องการ
}

interface LiveSession {
  mode: CtrlMode;
  target: number;
  baseline: number;
  kp: number;
  ki: number;
  kd: number;
  startedAtMs: number; // performance.now() ตอนเริ่ม
  startedAtClock: string;
  points: TelemetryPoint[];
  reached90: boolean;
  riseTimeMs: number | null;
  peakValue: number; // ค่าสูงสุด(หรือต่ำสุดถ้า target ติดลบ) ที่เคยเจอ ใช้หา overshoot
  settledSinceMs: number | null; // เวลาที่เริ่มอยู่ในแถบ tolerance ต่อเนื่อง (สำหรับ v)
}

// ===================================================================
// ค่าคงที่การวิเคราะห์
// ===================================================================

const VELOCITY_SETTLE_BAND = 0.02; // ±2% ของ target ถือว่า "นิ่ง" (โหมด v)
const VELOCITY_SETTLE_HOLD_MS = 500; // ต้องอยู่ในแถบต่อเนื่องอย่างน้อยเท่านี้ถึงนับว่านิ่งจริง
const MIN_TARGET_FOR_PCT = 1e-4; // กันหารด้วยศูนย์เวลา target ใกล้ 0
const MAX_SESSION_POINTS = 600; // กันหน่วยความจำบวมถ้า session ค้างนานผิดปกติ

function nowClock() {
  return new Date().toLocaleTimeString().slice(0, 8);
}

// ===================================================================
// Hook หลัก
// ===================================================================

export function useStepResponseAnalysis() {
  // session ที่กำลังดำเนินอยู่ (ใช้ ref เพราะอัปเดตทุก telemetry message ความถี่สูง
  // ไม่อยากให้ re-render รัวๆ จาก ref โดยตรง จะ sync เข้า state เฉพาะตอนที่ค่าที่โชว์เปลี่ยนจริง)
  const liveRef = useRef<LiveSession | null>(null);
  const lastTargetRef = useRef<number | null>(null);
  const lastModeRef = useRef<CtrlMode | null>(null);

  // ค่าที่ UI อ่านได้ตรงๆ
  const [liveSnapshot, setLiveSnapshot] = useState<{
    mode: CtrlMode;
    target: number;
    riseTimeMs: number | null;
    overshootPct: number | null;
    overshootAbs: number | null;
    settlingTimeMs: number | null;
    settled: boolean;
    elapsedMs: number;
  } | null>(null);

  const [history, setHistory] = useState<StepResult[]>([]);

  const finalizeSession = useCallback((settled: boolean) => {
    const live = liveRef.current;
    if (!live) return;

    const result: StepResult = {
      id: `${live.startedAtMs}`,
      mode: live.mode,
      target: live.target,
      baseline: live.baseline,
      kp: live.kp,
      ki: live.ki,
      kd: live.kd,
      startedAt: live.startedAtClock,
      riseTimeMs: live.riseTimeMs,
      overshootPct: live.mode === "v" ? computeOvershootPct(live) : null,
      overshootAbs: computeOvershootAbs(live),
      settlingTimeMs:
        live.settledSinceMs !== null
          ? live.settledSinceMs - live.startedAtMs
          : null,
      settled,
      points: live.points,
    };

    setHistory((prev) => [result, ...prev].slice(0, 50)); // เก็บ 50 step ล่าสุดพอ กันลิสต์ยาวเกิน
  }, []);

  // เรียกทุกครั้งที่มี telemetry message ใหม่เข้ามา
  // คืนค่าไม่ต้องก็ได้ แต่ส่ง point ปัจจุบันกลับไปเผื่อ caller อยากใช้ต่อ
  const ingest = useCallback(
    (
      payload: {
        pos: number;
        vel: number;
        target: number;
        mode: string;
        pwm: number;
        atTarget: boolean;
      },
      pid: { kp: number; ki: number; kd: number }
    ) => {
      const mode: CtrlMode = payload.mode === "p" ? "p" : "v";
      const target = payload.target;
      const nowMs = performance.now();

      const targetChanged =
        lastTargetRef.current === null ||
        target !== lastTargetRef.current ||
        mode !== lastModeRef.current;

      if (targetChanged) {
        // ปิด session เก่า (ถ้ามี) เป็น "ไม่นิ่งสมบูรณ์" เพราะโดนตัดด้วย step ใหม่ก่อน
        if (liveRef.current) {
          const wasSettled =
            liveRef.current.mode === "p"
              ? liveRef.current.points.length > 0 &&
                liveRef.current.points[liveRef.current.points.length - 1]
                  .atTarget
              : liveRef.current.settledSinceMs !== null;
          finalizeSession(wasSettled);
        }

        const baseline =
          liveRef.current?.mode === mode
            ? liveRef.current.mode === "p"
              ? liveRef.current.points[liveRef.current.points.length - 1]
                  ?.pos ?? 0
              : liveRef.current.points[liveRef.current.points.length - 1]
                  ?.vel ?? 0
            : mode === "p"
            ? payload.pos
            : payload.vel;

        liveRef.current = {
          mode,
          target,
          baseline,
          kp: pid.kp,
          ki: pid.ki,
          kd: pid.kd,
          startedAtMs: nowMs,
          startedAtClock: nowClock(),
          points: [],
          reached90: false,
          riseTimeMs: null,
          peakValue: mode === "p" ? payload.pos : payload.vel,
          settledSinceMs: null,
        };
        lastTargetRef.current = target;
        lastModeRef.current = mode;
      }

      const live = liveRef.current!;
      // อัปเดต pid ปัจจุบันไว้เสมอ เผื่อมีการจูนกลางคันโดยไม่เปลี่ยน target
      live.kp = pid.kp;
      live.ki = pid.ki;
      live.kd = pid.kd;

      const point: TelemetryPoint = {
        t: nowMs - live.startedAtMs,
        pos: payload.pos,
        vel: payload.vel,
        pwm: payload.pwm,
        atTarget: payload.atTarget,
      };
      live.points.push(point);
      if (live.points.length > MAX_SESSION_POINTS) live.points.shift();

      const currentValue = mode === "p" ? payload.pos : payload.vel;

      // --- ติดตามจุดสูงสุด (สำหรับ overshoot) ---
      // รองรับทั้ง target บวกและลบ: ดูว่ากำลังวิ่งไปทิศไหนแล้วหา extremum ในทิศนั้น
      const goingUp = live.target >= live.baseline;
      if (goingUp) {
        if (currentValue > live.peakValue) live.peakValue = currentValue;
      } else {
        if (currentValue < live.peakValue) live.peakValue = currentValue;
      }

      // --- rise time: เวลาที่แตะ 90% ของระยะทางจาก baseline ไป target ครั้งแรก ---
      if (!live.reached90) {
        const span = live.target - live.baseline;
        if (Math.abs(span) > MIN_TARGET_FOR_PCT) {
          const progress = (currentValue - live.baseline) / span;
          if (progress >= 0.9) {
            live.reached90 = true;
            live.riseTimeMs = point.t;
          }
        }
      }

      // --- settling time ---
      if (mode === "v") {
        const band = Math.max(
          Math.abs(live.target) * VELOCITY_SETTLE_BAND,
          0.001 // floor กันกรณี target = 0 พอดี (เช่น สั่งหยุด)
        );
        const withinBand = Math.abs(currentValue - live.target) <= band;

        if (withinBand) {
          // เข้าแถบครั้งแรก -> เริ่มจับเวลา (ถ้าเคยจับอยู่แล้วไม่ต้อง reset)
          if (live.settledSinceMs === null) live.settledSinceMs = nowMs;
        } else {
          live.settledSinceMs = null; // หลุดออกจากแถบ รีเซ็ตการนับใหม่
        }
      } else {
        // โหมด p ใช้ atTarget จาก firmware ตรงๆ (มันเช็ค POSITION_TOLERANCE ให้แล้ว)
        if (payload.atTarget) {
          if (live.settledSinceMs === null) live.settledSinceMs = nowMs;
        } else {
          live.settledSinceMs = null;
        }
      }

      // คำนวณว่า "นิ่งแล้วจริง" หรือยัง (ผ่าน hold time ขั้นต่ำ)
      const settledNow =
        live.settledSinceMs !== null &&
        (mode === "p" ||
          nowMs - live.settledSinceMs >= VELOCITY_SETTLE_HOLD_MS);

      setLiveSnapshot({
        mode: live.mode,
        target: live.target,
        riseTimeMs: live.riseTimeMs,
        overshootPct: live.mode === "v" ? computeOvershootPct(live) : null,
        overshootAbs: computeOvershootAbs(live),
        settlingTimeMs: settledNow
          ? (live.settledSinceMs as number) - live.startedAtMs
          : null,
        settled: settledNow,
        elapsedMs: nowMs - live.startedAtMs,
      });
    },
    [finalizeSession]
  );

  const clearHistory = useCallback(() => setHistory([]), []);

  return { liveSnapshot, history, ingest, clearHistory };
}

// ===================================================================
// Helper คำนวณ overshoot
// ===================================================================

function computeOvershootAbs(live: LiveSession): number | null {
  const goingUp = live.target >= live.baseline;
  const overshoot = goingUp
    ? live.peakValue - live.target
    : live.target - live.peakValue;
  return overshoot > 0 ? overshoot : 0;
}

function computeOvershootPct(live: LiveSession): number | null {
  if (Math.abs(live.target) < MIN_TARGET_FOR_PCT) return null; // target≈0 หา % ไม่ได้
  const abs = computeOvershootAbs(live);
  if (abs === null) return null;
  return (abs / Math.abs(live.target)) * 100;
}
