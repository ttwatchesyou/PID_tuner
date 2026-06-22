import React, { useEffect, useRef, useState } from "react";
import styled from "styled-components";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import { useMqttControl } from "../../hook/useMqttControl";
import { connectMQTT } from "../../lib/mqttClient";
import { useStepResponseAnalysis } from "../../hook/Usestepresponseanalysis";

// ===================================================================
// Helpers
// ===================================================================
function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function fmtPct(pct: number | null): string {
  if (pct === null) return "—";
  return `${pct.toFixed(1)}%`;
}
function fmtAbs(val: number | null, mode: "v" | "p"): string {
  if (val === null) return "—";
  return mode === "v"
    ? `${val.toFixed(0)} RPM`
    : `${(val * 1000).toFixed(1)} mm`;
}
function fmtTarget(val: number, mode: "v" | "p"): string {
  return mode === "v" ? `${val.toFixed(0)} RPM` : `${val.toFixed(3)} m`;
}

// ===================================================================
// Theme tokens
// ===================================================================
type ThemeTokens = {
  bg: string; surface: string; card: string; border: string;
  inputBg: string; text: string; textMuted: string; label: string;
  accent: string; accentHover: string; accentAlt: string;
  danger: string; dangerHover: string; success: string;
  chartGrid: string; tooltipBg: string; titleColor: string;
};

const DARK: ThemeTokens = {
  bg:          "#2D3C59",
  surface:     "#161b27",
  card:        "#1a2236",
  border:      "#2a3a5c",
  inputBg:     "#0b1020",
  text:        "#e8edf8",
  textMuted:   "#8899bb",
  label:       "#a78bfa",
  titleColor:  "#c4b5fd",
  accent:      "#7c3aed",
  accentHover: "#6d28d9",
  accentAlt:   "#06b6d4",
  danger:      "#f43f5e",
  dangerHover: "#e11d48",
  success:     "#10b981",
  chartGrid:   "rgba(255,255,255,0.07)",
  tooltipBg:   "#1a2236",
};
const LIGHT: ThemeTokens = {
  bg:          "#E8DDB4",
  surface:     "#ffffff",
  card:        "#ffffff",
  border:      "#c7d2fe",
  inputBg:     "#f5f7ff",
  text:        "#1e1b4b",
  textMuted:   "#6366f1",
  label:       "#7c3aed",
  titleColor:  "#7c3aed",
  accent:      "#7c3aed",
  accentHover: "#6d28d9",
  accentAlt:   "#0891b2",
  danger:      "#e11d48",
  dangerHover: "#be123c",
  success:     "#059669",
  chartGrid:   "rgba(99,102,241,0.1)",
  tooltipBg:   "#eef2ff",
};

// ===================================================================
// Slider Component
// ===================================================================
function PidSlider({
  label, value, min, max, step, onChange, color, theme,
}: {
  label: string; value: number; min: number; max: number;
  step: number; onChange: (v: number) => void; color: string;
  theme: ThemeTokens;
}) {
  return (
    <SliderWrap>
      <SliderRow>
        <SliderLabel style={{ color }}>{label}</SliderLabel>
        <SliderNum $theme={theme}>
          {value.toFixed(step < 0.1 ? 3 : step < 1 ? 2 : 1)}
        </SliderNum>
      </SliderRow>
      <StyledRange
        type="range" min={min} max={max} step={step} value={value}
        $color={color}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <SliderMinMax $theme={theme}>
        <span>{min}</span>
        <span>{max}</span>
      </SliderMinMax>
    </SliderWrap>
  );
}

// ===================================================================
// Main
// ===================================================================
function MainPartSection() {
  const { sendTarget, sendPID } = useMqttControl();
  const { liveSnapshot, history, ingest, clearHistory } = useStepResponseAnalysis();

  const [isDark, setIsDark] = useState(true);
  const theme = isDark ? DARK : LIGHT;

  const [ctrlMode, setCtrlMode] = useState<"v" | "p">("v");
  const [targetVal, setTargetVal] = useState<number>(0);
  const [pid, setPid] = useState({ kp: 1.0, ki: 0.1, kd: 0.01 });
  const sendPidTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chartData, setChartData] = useState<any[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [atTarget, setAtTarget] = useState(false);
  const [latest, setLatest] = useState<{ pos?: number; vel?: number; pwm?: number }>({});

  const handlePidChange = (key: "kp" | "ki" | "kd", val: number) => {
    const next = { ...pid, [key]: val };
    setPid(next);
    if (sendPidTimeout.current) clearTimeout(sendPidTimeout.current);
    sendPidTimeout.current = setTimeout(() => {
      sendPID(next.kp, next.ki, next.kd);
    }, 150);
  };

  useEffect(() => {
    const client = connectMQTT();
    const handleConnect = () => setIsConnected(true);
    const handleClose = () => setIsConnected(false);
    const handleMessage = (topic: string, message: Uint8Array) => {
      if (topic !== "telemetry/data") return;
      try {
        const payload = JSON.parse(message.toString());
        const t = Date.now();
        setChartData((prev) => [
          ...prev.slice(-59),
          {
            t,
            pos: typeof payload.pos === "number" ? Number(payload.pos.toFixed(4)) : 0,
            vel: typeof payload.vel === "number" ? Number(payload.vel.toFixed(1)) : 0,
            target: typeof payload.target === "number" ? Number(payload.target.toFixed(1)) : 0,
            pwm: payload.pwm ?? 0,
            mode: payload.mode ?? "v",
          },
        ]);
        setAtTarget(Boolean(payload.atTarget));
        setLatest({ pos: payload.pos, vel: payload.vel, pwm: payload.pwm });
        ingest(payload, pid);
      } catch (e) {
        console.error("JSON Parse Error", e);
      }
    };
    client.on("connect", handleConnect);
    client.on("close", handleClose);
    client.on("offline", handleClose);
    client.on("message", handleMessage);
    return () => {
      client.removeListener("connect", handleConnect);
      client.removeListener("close", handleClose);
      client.removeListener("offline", handleClose);
      client.removeListener("message", handleMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid]);

  const velKey = "vel";
  const targetKey = "target";
  const getVelDomain = (): [number, number] => {
    if (chartData.length === 0) return [-100, 100];
    const vals = chartData.flatMap((d) => [d.vel, d.target]).filter((v) => typeof v === "number");
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = Math.max(Math.abs(max - min) * 0.15, 10);
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  };

  const isVelMode = ctrlMode === "v";

  return (
    <MainSection $theme={theme}>
      <MainBox>

        {/* Header */}
        <Header>
          <HeaderTop>
            <Title $theme={theme}>MOTOR PID TUNING STATION</Title>
            <ThemeToggle $theme={theme} onClick={() => setIsDark(!isDark)} title="Toggle theme">
              {isDark ? "☀️" : "🌙"}
            </ThemeToggle>
          </HeaderTop>
          <StatusRow>
            <StatusDot $ok={isConnected} />
            <StatusText $theme={theme}>{isConnected ? "Connected" : "Disconnected"}</StatusText>
            {ctrlMode === "p" && atTarget && (
              <TargetBadge $theme={theme}>✓ At target</TargetBadge>
            )}
          </StatusRow>
        </Header>

        {/* Readout */}
        <ReadoutRow>
          {[
            { label: "Position", value: `${(latest.pos ?? 0).toFixed(4)} m` },
            {
              label: isVelMode ? "Speed" : "Velocity",
              value: isVelMode
                ? `${(latest.vel ?? 0).toFixed(0)} RPM`
                : `${(latest.vel ?? 0).toFixed(4)} m/s`,
            },
            { label: "PWM", value: `${latest.pwm ?? 0} / 255` },
            { label: "PWM %", value: `${(((latest.pwm ?? 0) / 255) * 100).toFixed(0)}%` },
          ].map((item) => (
            <ReadoutItem key={item.label} $theme={theme}>
              <ReadoutLabel $theme={theme}>{item.label}</ReadoutLabel>
              <ReadoutValue $theme={theme}>{item.value}</ReadoutValue>
            </ReadoutItem>
          ))}
        </ReadoutRow>

        {/* Realtime Chart */}
        <ChartCard $theme={theme}>
          <CardTitleRow>
            <CardTitle $theme={theme}>
              Realtime — {isVelMode ? "Velocity (RPM)" : "Position (m)"}
            </CardTitle>
            <ChartLegendRow $theme={theme}>
              <LegendDot $c="#f43f5e" /> Target
              <LegendDot $c="#06b6d4" style={{ marginLeft: 12 }} />{" "}
              {isVelMode ? "Speed" : "Vel"}
              {!isVelMode && (
                <><LegendDot $c="#fbbf24" style={{ marginLeft: 12 }} /> Pos</>
              )}
            </ChartLegendRow>
          </CardTitleRow>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.chartGrid} />
              <XAxis dataKey="t" hide />
              {isVelMode ? (
                <>
                  <YAxis domain={getVelDomain()} stroke={theme.textMuted} tick={{ fontSize: 10, fill: theme.textMuted }} width={44} />
                  <Tooltip contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.border}`, fontSize: 12, color: theme.text }} formatter={(v: any, name: string) => [`${Number(v).toFixed(1)} RPM`, name]} />
                  <Line type="monotone" dataKey={targetKey} stroke="#f43f5e" strokeWidth={2} strokeDasharray="5 3" dot={false} name="Target" isAnimationActive={false} />
                  <Line type="monotone" dataKey={velKey} stroke="#06b6d4" strokeWidth={2} dot={false} name="Speed" isAnimationActive={false} />
                </>
              ) : (
                <>
                  <YAxis yAxisId="pos" orientation="left" stroke="#fbbf24" tick={{ fontSize: 10, fill: theme.textMuted }} width={52} tickFormatter={(v) => v.toFixed(3)} />
                  <YAxis yAxisId="vel" orientation="right" stroke="#06b6d4" tick={{ fontSize: 10, fill: theme.textMuted }} width={44} tickFormatter={(v) => v.toFixed(2)} />
                  <Tooltip contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.border}`, fontSize: 12, color: theme.text }} formatter={(v: any, name: string) => name === "Pos" ? [`${Number(v).toFixed(4)} m`, name] : [`${Number(v).toFixed(4)} m/s`, name]} />
                  {chartData.length > 0 && (
                    <ReferenceLine yAxisId="pos" y={chartData[chartData.length - 1]?.target ?? 0} stroke="#f43f5e" strokeDasharray="5 3" label={{ value: "Target", fill: "#f43f5e", fontSize: 10, position: "insideTopRight" }} />
                  )}
                  <Line yAxisId="pos" type="monotone" dataKey="pos" stroke="#fbbf24" strokeWidth={2} dot={false} name="Pos" isAnimationActive={false} />
                  <Line yAxisId="vel" type="monotone" dataKey="vel" stroke="#06b6d4" strokeWidth={1.5} dot={false} name="Vel" isAnimationActive={false} />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* PWM Chart */}
        <ChartCard $theme={theme}>
          <CardTitle $theme={theme}>PWM Output</CardTitle>
          <ResponsiveContainer width="100%" height={90}>
            <LineChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={theme.chartGrid} />
              <XAxis dataKey="t" hide />
              <YAxis domain={[-255, 255]} stroke={theme.textMuted} tick={{ fontSize: 10, fill: theme.textMuted }} width={32} />
              <ReferenceLine y={0} stroke={theme.border} />
              <Tooltip contentStyle={{ background: theme.tooltipBg, border: `1px solid ${theme.border}`, fontSize: 12, color: theme.text }} formatter={(v: any) => [v, "PWM"]} />
              <Line type="monotone" dataKey="pwm" stroke="#a78bfa" strokeWidth={1.5} dot={false} name="PWM" isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Control + PID */}
        <TwoCol>
          <ControlCard $theme={theme}>
            <CardTitle $theme={theme}>🎯 Motor Control</CardTitle>
            <ModeToggleRow>
              <ModeBtn $active={ctrlMode === "v"} $theme={theme} onClick={() => setCtrlMode("v")}>
                Velocity (RPM)
              </ModeBtn>
              <ModeBtn $active={ctrlMode === "p"} $theme={theme} onClick={() => setCtrlMode("p")}>
                Position (m)
              </ModeBtn>
            </ModeToggleRow>
            <ControlLabel $theme={theme}>Target {isVelMode ? "(RPM, ±200)" : "(เมตร)"}</ControlLabel>
            <ControlInput
              $theme={theme}
              type="number"
              value={targetVal}
              step={isVelMode ? 50 : 0.001}
              onChange={(e) => setTargetVal(Number(e.target.value))}
              onKeyDown={(e) => e.key === "Enter" && sendTarget(ctrlMode, targetVal)}
            />
            <ControlButton $theme={theme} onClick={() => sendTarget(ctrlMode, targetVal)}>
              Send Command
            </ControlButton>
            <StopButton $theme={theme} onClick={() => { setTargetVal(0); sendTarget(ctrlMode, 0); }}>
              ⏹ STOP
            </StopButton>
          </ControlCard>

          <ControlCard $theme={theme}>
            <CardTitle $theme={theme}>
              🎛️ PID Tuning <SliderHint $theme={theme}>(realtime)</SliderHint>
            </CardTitle>
            <PidSlider label="Kp" value={pid.kp} min={0} max={100} step={0.05} color="#f43f5e" theme={theme} onChange={(v) => handlePidChange("kp", v)} />
            <PidSlider label="Ki" value={pid.ki} min={0} max={100} step={0.01} color="#fbbf24" theme={theme} onChange={(v) => handlePidChange("ki", v)} />
            <PidSlider label="Kd" value={pid.kd} min={0} max={100} step={0.005} color="#06b6d4" theme={theme} onChange={(v) => handlePidChange("kd", v)} />
            <PidManualRow>
              {(["kp", "ki", "kd"] as const).map((k) => (
                <PidInput
                  key={k}
                  $theme={theme}
                  type="number"
                  value={pid[k]}
                  step={k === "kd" ? 0.001 : 0.01}
                  onChange={(e) => handlePidChange(k, Number(e.target.value))}
                  placeholder={k.toUpperCase()}
                />
              ))}
            </PidManualRow>
            <ControlButton $theme={theme} onClick={() => sendPID(pid.kp, pid.ki, pid.kd)} style={{ marginTop: 8, background: theme.success }}>
              Send PID
            </ControlButton>
          </ControlCard>
        </TwoCol>

        {/* Step Response Live */}
        <ChartCard $theme={theme}>
          <CardTitleRow>
            <CardTitle $theme={theme}>Step Response — Live</CardTitle>
            {liveSnapshot && (
              <LiveStateBadge $settled={liveSnapshot.settled} $theme={theme}>
                {liveSnapshot.settled ? "Settled" : "Settling…"}
              </LiveStateBadge>
            )}
          </CardTitleRow>
          {!liveSnapshot ? (
            <EmptyHint $theme={theme}>ยังไม่มีข้อมูล step — ส่งคำสั่ง target อย่างน้อยหนึ่งครั้ง</EmptyHint>
          ) : (
            <MetricsRow>
              {[
                { label: "Target", value: fmtTarget(liveSnapshot.target, liveSnapshot.mode) },
                { label: "Rise Time (90%)", value: fmtMs(liveSnapshot.riseTimeMs) },
                {
                  label: "Overshoot",
                  value: liveSnapshot.mode === "v" ? fmtPct(liveSnapshot.overshootPct) : fmtAbs(liveSnapshot.overshootAbs, "p"),
                },
                { label: "Settling Time", value: fmtMs(liveSnapshot.settlingTimeMs) },
                { label: "Elapsed", value: fmtMs(liveSnapshot.elapsedMs) },
              ].map((m) => (
                <MetricBox key={m.label} $theme={theme}>
                  <MetricLabel $theme={theme}>{m.label}</MetricLabel>
                  <MetricValue $theme={theme}>{m.value}</MetricValue>
                </MetricBox>
              ))}
            </MetricsRow>
          )}
        </ChartCard>

        {/* History Table */}
        <ChartCard $theme={theme}>
          <CardTitleRow>
            <CardTitle $theme={theme}>Step Response — History</CardTitle>
            <ClearButton $theme={theme} onClick={clearHistory} disabled={history.length === 0}>
              Clear
            </ClearButton>
          </CardTitleRow>
          {history.length === 0 ? (
            <EmptyHint $theme={theme}>ยังไม่มีประวัติ — แต่ละครั้งที่เปลี่ยน target จะถูกบันทึกหลัง step นิ่ง</EmptyHint>
          ) : (
            <TableWrap>
              <HistoryTable $theme={theme}>
                <thead>
                  <tr>
                    <th>เวลา</th><th>Mode</th><th>Target</th>
                    <th>Kp / Ki / Kd</th><th>Rise</th>
                    <th>Overshoot</th><th>Settling</th><th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.startedAt}</td>
                      <td><ModeTag $mode={h.mode}>{h.mode === "v" ? "Velocity" : "Position"}</ModeTag></td>
                      <td>{fmtTarget(h.target, h.mode)}</td>
                      <td className="mono">{h.kp.toFixed(2)}/{h.ki.toFixed(2)}/{h.kd.toFixed(3)}</td>
                      <td>{fmtMs(h.riseTimeMs)}</td>
                      <td>{h.mode === "v" ? fmtPct(h.overshootPct) : fmtAbs(h.overshootAbs, "p")}</td>
                      <td>{fmtMs(h.settlingTimeMs)}</td>
                      <td><SettledTag $settled={h.settled}>{h.settled ? "Settled" : "Cut off"}</SettledTag></td>
                    </tr>
                  ))}
                </tbody>
              </HistoryTable>
            </TableWrap>
          )}
        </ChartCard>

      </MainBox>
    </MainSection>
  );
}

// ===================================================================
// Styled Components — all theme-aware
// ===================================================================
type T = { $theme: ThemeTokens };

const MainSection = styled.div<T>`
  background: ${(p) => p.$theme.bg};
  padding: 24px 16px 40px;
  margin-top: 80px;
  min-height: 100vh;
  display: flex;
  justify-content: center;
  transition: background 0.25s;

  @media (max-width: 390px) {
    padding: 16px 10px 32px;
    margin-top: 60px;
  }
`;
const MainBox = styled.div`
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 14px;
`;
const Header = styled.div`
  text-align: center;
`;
const HeaderTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  position: relative;
`;
const Title = styled.h1<T>`
  margin: 0;
  font-size: clamp(1.1rem, 4vw, 1.6rem);
  letter-spacing: 0.06em;
  color: ${(p) => p.$theme.titleColor};
`;
const ThemeToggle = styled.button<T>`
  background: ${(p) => p.$theme.card};
  border: 1px solid ${(p) => p.$theme.border};
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 1.1rem;
  cursor: pointer;
  line-height: 1;
  transition: background 0.2s;
  &:hover { background: ${(p) => p.$theme.surface}; }
`;
const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
`;
const StatusDot = styled.span<{ $ok: boolean }>`
  width: 8px; height: 8px; border-radius: 50%;
  background: ${(p) => (p.$ok ? "#10b981" : "#f43f5e")};
  box-shadow: ${(p) => (p.$ok ? "0 0 6px #10b981" : "none")};
`;
const StatusText = styled.span<T>`
  font-size: 0.75rem;
  color: ${(p) => p.$theme.textMuted};
`;
const TargetBadge = styled.span<T>`
  font-size: 0.7rem;
  background: #10b981;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
`;
const ReadoutRow = styled.div`
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 8px;

  @media (max-width: 480px) {
    grid-template-columns: repeat(2, 1fr);
  }
`;
const ReadoutItem = styled.div<T>`
  background: ${(p) => p.$theme.card};
  border: 1px solid ${(p) => p.$theme.border};
  border-radius: 10px;
  padding: 10px 8px;
  text-align: center;
`;
const ReadoutLabel = styled.div<T>`
  font-size: 0.6rem;
  color: ${(p) => p.$theme.label};
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 4px;
`;
const ReadoutValue = styled.div<T>`
  font-size: clamp(0.85rem, 2.5vw, 1.05rem);
  color: ${(p) => p.$theme.text};
  font-weight: bold;
  font-variant-numeric: tabular-nums;
`;
const ChartCard = styled.div<T>`
  background: ${(p) => p.$theme.card};
  border: 1px solid ${(p) => p.$theme.border};
  padding: 14px 14px 10px;
  border-radius: 10px;
`;
const CardTitle = styled.div<T>`
  color: ${(p) => p.$theme.text};
  margin-bottom: 8px;
  font-weight: bold;
  font-size: 0.88rem;
`;
const CardTitleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  flex-wrap: wrap;
  gap: 6px;
`;
const ChartLegendRow = styled.div<T>`
  display: flex;
  align-items: center;
  font-size: 0.72rem;
  color: ${(p) => p.$theme.textMuted};
`;
const LegendDot = styled.span<{ $c: string }>`
  display: inline-block;
  width: 10px; height: 10px; border-radius: 50%;
  background: ${(p) => p.$c};
  margin-right: 4px;
`;
const TwoCol = styled.div`
  display: flex;
  gap: 14px;
  @media (max-width: 600px) { flex-direction: column; }
`;
const ControlCard = styled.div<T>`
  flex: 1;
  background: ${(p) => p.$theme.card};
  border: 1px solid ${(p) => p.$theme.border};
  padding: 14px;
  border-radius: 10px;
`;
const ControlLabel = styled.div<T>`
  color: ${(p) => p.$theme.label};
  font-size: 0.78rem;
  margin: 8px 0 4px;
`;
const ControlInput = styled.input<T>`
  width: 100%;
  padding: 8px;
  border-radius: 6px;
  border: 1px solid ${(p) => p.$theme.border};
  background: ${(p) => p.$theme.inputBg};
  color: ${(p) => p.$theme.text};
  font-size: 1rem;
  box-sizing: border-box;
  &:focus { outline: 2px solid ${(p) => p.$theme.accent}; border-color: transparent; }
`;
const ControlButton = styled.button<T>`
  width: 100%;
  padding: 9px;
  margin-top: 10px;
  border-radius: 6px;
  border: none;
  background: ${(p) => p.$theme.accent};
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  font-size: 0.88rem;
  transition: background 0.15s;
  &:hover { background: ${(p) => p.$theme.accentHover}; }
`;
const StopButton = styled.button<T>`
  width: 100%;
  padding: 9px;
  margin-top: 6px;
  border-radius: 6px;
  border: none;
  background: ${(p) => p.$theme.danger};
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  font-size: 0.88rem;
  transition: background 0.15s;
  &:hover { background: ${(p) => p.$theme.dangerHover}; }
`;
const ModeToggleRow = styled.div`
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
`;
const ModeBtn = styled.button<{ $active: boolean } & T>`
  flex: 1;
  padding: 7px 4px;
  border-radius: 6px;
  border: 1px solid ${(p) => p.$theme.border};
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: bold;
  transition: background 0.15s, color 0.15s;
  background: ${(p) => (p.$active ? p.$theme.accent : "transparent")};
  color: ${(p) => (p.$active ? "#fff" : p.$theme.textMuted)};
`;
const SliderWrap = styled.div`
  margin-bottom: 10px;
`;
const SliderRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`;
const SliderLabel = styled.span`
  font-size: 0.8rem;
  font-weight: bold;
`;
const SliderNum = styled.span<T>`
  font-size: 0.82rem;
  color: ${(p) => p.$theme.text};
  font-variant-numeric: tabular-nums;
  background: ${(p) => p.$theme.inputBg};
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid ${(p) => p.$theme.border};
`;
const StyledRange = styled.input<{ $color: string }>`
  width: 100%;
  margin: 4px 0 2px;
  accent-color: ${(p) => p.$color};
`;
const SliderMinMax = styled.div<T>`
  display: flex;
  justify-content: space-between;
  font-size: 0.6rem;
  color: ${(p) => p.$theme.textMuted};
`;
const PidManualRow = styled.div`
  display: flex;
  gap: 6px;
  margin-top: 8px;
`;
const PidInput = styled.input<T>`
  flex: 1;
  min-width: 0;
  padding: 5px 4px;
  border-radius: 4px;
  border: 1px solid ${(p) => p.$theme.border};
  background: ${(p) => p.$theme.inputBg};
  color: ${(p) => p.$theme.text};
  font-size: 0.8rem;
  text-align: center;
  &:focus { outline: 2px solid ${(p) => p.$theme.accent}; border-color: transparent; }
`;
const SliderHint = styled.span<T>`
  font-size: 0.65rem;
  color: ${(p) => p.$theme.textMuted};
  font-weight: normal;
  margin-left: 6px;
`;
const LiveStateBadge = styled.span<{ $settled: boolean } & T>`
  font-size: 0.7rem;
  font-weight: bold;
  padding: 3px 10px;
  border-radius: 10px;
  color: #fff;
  background: ${(p) => (p.$settled ? "#10b981" : "#d97706")};
`;
const EmptyHint = styled.div<T>`
  color: ${(p) => p.$theme.textMuted};
  font-size: 0.8rem;
  padding: 8px 0;
`;
const MetricsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;
const MetricBox = styled.div<T>`
  flex: 1;
  min-width: 80px;
  background: ${(p) => p.$theme.surface};
  border: 1px solid ${(p) => p.$theme.border};
  border-radius: 8px;
  padding: 10px 10px;
  text-align: center;
`;
const MetricLabel = styled.div<T>`
  font-size: 0.58rem;
  color: ${(p) => p.$theme.label};
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
`;
const MetricValue = styled.div<T>`
  font-size: clamp(0.82rem, 2vw, 1rem);
  color: ${(p) => p.$theme.text};
  font-weight: bold;
  font-variant-numeric: tabular-nums;
`;
const ClearButton = styled.button<T>`
  background: transparent;
  border: 1px solid ${(p) => p.$theme.border};
  color: ${(p) => p.$theme.textMuted};
  font-size: 0.7rem;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  &:hover:not(:disabled) {
    border-color: ${(p) => p.$theme.danger};
    color: ${(p) => p.$theme.danger};
  }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`;
const TableWrap = styled.div`
  overflow-x: auto;
  max-height: 280px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
`;
const HistoryTable = styled.table<T>`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.76rem;
  color: ${(p) => p.$theme.text};
  th, td {
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid ${(p) => p.$theme.border};
  }
  th {
    color: ${(p) => p.$theme.label};
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    position: sticky;
    top: 0;
    background: ${(p) => p.$theme.card};
  }
  td.mono {
    font-variant-numeric: tabular-nums;
    font-family: "Consolas", monospace;
  }
`;
const ModeTag = styled.span<{ $mode: "v" | "p" }>`
  font-size: 0.62rem;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 8px;
  color: #111;
  background: ${(p) => (p.$mode === "v" ? "#06b6d4" : "#fbbf24")};
`;
const SettledTag = styled.span<{ $settled: boolean }>`
  font-size: 0.65rem;
  font-weight: bold;
  color: ${(p) => (p.$settled ? "#10b981" : "#f43f5e")};
`;

export default MainPartSection;