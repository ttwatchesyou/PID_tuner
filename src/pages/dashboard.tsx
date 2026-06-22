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
  Legend,
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
// Slider Component (จูน PID แบบ realtime ไม่ต้องกด button)
// ===================================================================
function PidSlider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  color,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  color: string;
}) {
  return (
    <SliderWrap>
      <SliderRow>
        <SliderLabel style={{ color }}>{label}</SliderLabel>
        <SliderNum>
          {value.toFixed(step < 0.1 ? 3 : step < 1 ? 2 : 1)}
        </SliderNum>
      </SliderRow>
      <StyledRange
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        $color={color}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <SliderMinMax>
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
  const { liveSnapshot, history, ingest, clearHistory } =
    useStepResponseAnalysis();

  const [ctrlMode, setCtrlMode] = useState<"v" | "p">("v");
  const [targetVal, setTargetVal] = useState<number>(0);
  const [pid, setPid] = useState({ kp: 1.0, ki: 0.1, kd: 0.01 });
  const sendPidTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [chartData, setChartData] = useState<any[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [atTarget, setAtTarget] = useState(false);
  const [latest, setLatest] = useState<{
    pos?: number;
    vel?: number;
    pwm?: number;
  }>({});

  // debounce ส่ง PID ไม่ให้ spam ทุก pixel ที่ slider เลื่อน
  const handlePidChange = (key: "kp" | "ki" | "kd", val: number) => {
    const next = { ...pid, [key]: val };
    setPid(next);
    if (sendPidTimeout.current) clearTimeout(sendPidTimeout.current);
    sendPidTimeout.current = setTimeout(() => {
      sendPID(next.kp, next.ki, next.kd);
    }, 150);
  };

  // รับ telemetry จาก MQTT
  useEffect(() => {
    const client = connectMQTT();
    const handleConnect = () => setIsConnected(true);
    const handleClose = () => setIsConnected(false);

    const handleMessage = (topic: string, message: Uint8Array) => {
      if (topic !== "telemetry/data") return;
      try {
        const payload = JSON.parse(message.toString());
        const t = Date.now();

        // [แก้] เก็บทุก key ที่ ESP32 ส่งมา รวมถึง target และ mode
        setChartData((prev) => [
          ...prev.slice(-59),
          {
            t,
            pos:
              typeof payload.pos === "number"
                ? Number(payload.pos.toFixed(4))
                : 0,
            vel:
              typeof payload.vel === "number"
                ? Number(payload.vel.toFixed(1))
                : 0,
            target:
              typeof payload.target === "number"
                ? Number(payload.target.toFixed(1))
                : 0,
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

  // กำหนดว่ากราฟแต่ละ mode จะใช้ key ไหนและหน่วยอะไร
  const velKey = "vel";
  const targetKey = "target";
  // [แก้] domain อัตโนมัติตาม mode: mode v ใช้ RPM, mode p ใช้เมตร
  // ป้องกันเส้นหายเพราะ domain กว้างเกิน
  const getVelDomain = (): [number, number] => {
    if (chartData.length === 0) return [-100, 100];
    const vals = chartData
      .flatMap((d) => [d.vel, d.target])
      .filter((v) => typeof v === "number");
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const pad = Math.max(Math.abs(max - min) * 0.15, 10);
    return [Math.floor(min - pad), Math.ceil(max + pad)];
  };

  const isVelMode = ctrlMode === "v";

  return (
    <MainSection>
      <MainBox>
        {/* Header */}
        <Header>
          <Title>MOTOR PID TUNING STATION</Title>
          <StatusRow>
            <StatusDot $ok={isConnected} />
            <StatusText>
              {isConnected ? "Connected" : "Disconnected"}
            </StatusText>
            {ctrlMode === "p" && atTarget && (
              <TargetBadge>✓ At target</TargetBadge>
            )}
          </StatusRow>
        </Header>

        {/* Readout */}
        <ReadoutRow>
          <ReadoutItem>
            <ReadoutLabel>Position</ReadoutLabel>
            <ReadoutValue>{(latest.pos ?? 0).toFixed(4)} m</ReadoutValue>
          </ReadoutItem>
          <ReadoutItem>
            <ReadoutLabel>{isVelMode ? "Speed" : "Velocity"}</ReadoutLabel>
            <ReadoutValue>
              {isVelMode
                ? `${(latest.vel ?? 0).toFixed(0)} RPM`
                : `${(latest.vel ?? 0).toFixed(4)} m/s`}
            </ReadoutValue>
          </ReadoutItem>
          <ReadoutItem>
            <ReadoutLabel>PWM</ReadoutLabel>
            <ReadoutValue>{latest.pwm ?? 0} / 255</ReadoutValue>
          </ReadoutItem>
          <ReadoutItem>
            <ReadoutLabel>PWM %</ReadoutLabel>
            <ReadoutValue>
              {(((latest.pwm ?? 0) / 255) * 100).toFixed(0)}%
            </ReadoutValue>
          </ReadoutItem>
        </ReadoutRow>

        {/* ============ กราฟ Realtime ============ */}
        <ChartCard>
          <CardTitleRow>
            <CardTitle>
              Realtime — {isVelMode ? "Velocity (RPM)" : "Position (m)"}
            </CardTitle>
            <ChartLegendRow>
              <LegendDot $c="#ff6b6b" /> Target
              <LegendDot $c="#00e6ff" style={{ marginLeft: 12 }} />{" "}
              {isVelMode ? "Speed" : "Vel"}
              {!isVelMode && (
                <>
                  <LegendDot $c="#ffcc00" style={{ marginLeft: 12 }} /> Pos
                </>
              )}
            </ChartLegendRow>
          </CardTitleRow>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.08)"
              />
              <XAxis dataKey="t" hide />

              {/* [แก้] mode v: แสดง vel vs target บนแกนเดียว (RPM)
                       mode p: แกนซ้าย=pos(m), แกนขวา=vel(m/s) */}
              {isVelMode ? (
                <>
                  <YAxis
                    domain={getVelDomain()}
                    stroke="#aaa"
                    tick={{ fontSize: 10 }}
                    width={48}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0d1f4a",
                      border: "none",
                      fontSize: 12,
                    }}
                    formatter={(v: any, name: string) => [
                      `${Number(v).toFixed(1)} RPM`,
                      name,
                    ]}
                  />
                  <Line
                    type="monotone"
                    dataKey={targetKey}
                    stroke="#ff6b6b"
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    name="Target"
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey={velKey}
                    stroke="#00e6ff"
                    strokeWidth={2}
                    dot={false}
                    name="Speed"
                    isAnimationActive={false}
                  />
                </>
              ) : (
                <>
                  <YAxis
                    yAxisId="pos"
                    orientation="left"
                    stroke="#ffcc00"
                    tick={{ fontSize: 10 }}
                    width={56}
                    tickFormatter={(v) => v.toFixed(3)}
                  />
                  <YAxis
                    yAxisId="vel"
                    orientation="right"
                    stroke="#00e6ff"
                    tick={{ fontSize: 10 }}
                    width={48}
                    tickFormatter={(v) => v.toFixed(2)}
                  />
                  <Tooltip
                    contentStyle={{
                      background: "#0d1f4a",
                      border: "none",
                      fontSize: 12,
                    }}
                    formatter={(v: any, name: string) =>
                      name === "Pos"
                        ? [`${Number(v).toFixed(4)} m`, name]
                        : [`${Number(v).toFixed(4)} m/s`, name]
                    }
                  />
                  {/* เส้น target position เป็น ReferenceLine แนวนอน */}
                  {chartData.length > 0 && (
                    <ReferenceLine
                      yAxisId="pos"
                      y={chartData[chartData.length - 1]?.target ?? 0}
                      stroke="#ff6b6b"
                      strokeDasharray="5 3"
                      label={{
                        value: "Target",
                        fill: "#ff6b6b",
                        fontSize: 10,
                        position: "insideTopRight",
                      }}
                    />
                  )}
                  <Line
                    yAxisId="pos"
                    type="monotone"
                    dataKey="pos"
                    stroke="#ffcc00"
                    strokeWidth={2}
                    dot={false}
                    name="Pos"
                    isAnimationActive={false}
                  />
                  <Line
                    yAxisId="vel"
                    type="monotone"
                    dataKey="vel"
                    stroke="#00e6ff"
                    strokeWidth={1.5}
                    dot={false}
                    name="Vel"
                    isAnimationActive={false}
                  />
                </>
              )}
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* ============ PWM Chart ============ */}
        <ChartCard>
          <CardTitle>PWM Output</CardTitle>
          <ResponsiveContainer width="100%" height={100}>
            <LineChart
              data={chartData}
              margin={{ top: 4, right: 16, left: 0, bottom: 4 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                stroke="rgba(255,255,255,0.06)"
              />
              <XAxis dataKey="t" hide />
              <YAxis
                domain={[-255, 255]}
                stroke="#aaa"
                tick={{ fontSize: 10 }}
                width={36}
              />
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
              <Tooltip
                contentStyle={{
                  background: "#0d1f4a",
                  border: "none",
                  fontSize: 12,
                }}
                formatter={(v: any) => [v, "PWM"]}
              />
              <Line
                type="monotone"
                dataKey="pwm"
                stroke="#a78bfa"
                strokeWidth={1.5}
                dot={false}
                name="PWM"
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* ============ Control + PID (2 คอลัมน์) ============ */}
        <TwoCol>
          {/* Motor Control */}
          <ControlCard>
            <CardTitle>🎯 Motor Control</CardTitle>
            <ModeToggleRow>
              <ModeBtn
                $active={ctrlMode === "v"}
                onClick={() => setCtrlMode("v")}
              >
                Velocity (RPM)
              </ModeBtn>
              <ModeBtn
                $active={ctrlMode === "p"}
                onClick={() => setCtrlMode("p")}
              >
                Position (m)
              </ModeBtn>
            </ModeToggleRow>
            <ControlLabel>
              Target {isVelMode ? "(RPM, ±40)" : "(เมตร)"}
            </ControlLabel>
            <ControlInput
              type="number"
              value={targetVal}
              step={isVelMode ? 50 : 0.001}
              onChange={(e) => setTargetVal(Number(e.target.value))}
              onKeyDown={(e) =>
                e.key === "Enter" && sendTarget(ctrlMode, targetVal)
              }
            />
            <ControlButton onClick={() => sendTarget(ctrlMode, targetVal)}>
              Send Command
            </ControlButton>
            <StopButton
              onClick={() => {
                setTargetVal(0);
                sendTarget(ctrlMode, 0);
              }}
            >
              ⏹ STOP
            </StopButton>
          </ControlCard>

          {/* PID Sliders */}
          <ControlCard>
            <CardTitle>
              🎛️ PID Tuning <SliderHint>(realtime)</SliderHint>
            </CardTitle>
            <PidSlider
              label="Kp"
              value={pid.kp}
              min={0}
              max={100}
              step={0.05}
              color="#ff6b6b"
              onChange={(v) => handlePidChange("kp", v)}
            />
            <PidSlider
              label="Ki"
              value={pid.ki}
              min={0}
              max={100}
              step={0.01}
              color="#ffd700"
              onChange={(v) => handlePidChange("ki", v)}
            />
            <PidSlider
              label="Kd"
              value={pid.kd}
              min={0}
              max={100}
              step={0.005}
              color="#00e6ff"
              onChange={(v) => handlePidChange("kd", v)}
            />
            <PidManualRow>
              <PidInput
                type="number"
                value={pid.kp}
                step={0.01}
                onChange={(e) => handlePidChange("kp", Number(e.target.value))}
                placeholder="Kp"
              />
              <PidInput
                type="number"
                value={pid.ki}
                step={0.01}
                onChange={(e) => handlePidChange("ki", Number(e.target.value))}
                placeholder="Ki"
              />
              <PidInput
                type="number"
                value={pid.kd}
                step={0.001}
                onChange={(e) => handlePidChange("kd", Number(e.target.value))}
                placeholder="Kd"
              />
            </PidManualRow>
            <ControlButton
              onClick={() => sendPID(pid.kp, pid.ki, pid.kd)}
              style={{ marginTop: 8, background: "#28a745" }}
            >
              Send PID
            </ControlButton>
          </ControlCard>
        </TwoCol>

        {/* ============ Step Response Live ============ */}
        <ChartCard>
          <CardTitleRow>
            <CardTitle>Step Response — Live</CardTitle>
            {liveSnapshot && (
              <LiveStateBadge $settled={liveSnapshot.settled}>
                {liveSnapshot.settled ? "Settled" : "Settling…"}
              </LiveStateBadge>
            )}
          </CardTitleRow>
          {!liveSnapshot ? (
            <EmptyHint>
              ยังไม่มีข้อมูล step — ส่งคำสั่ง target อย่างน้อยหนึ่งครั้ง
            </EmptyHint>
          ) : (
            <MetricsRow>
              <MetricBox>
                <MetricLabel>Target</MetricLabel>
                <MetricValue>
                  {fmtTarget(liveSnapshot.target, liveSnapshot.mode)}
                </MetricValue>
              </MetricBox>
              <MetricBox>
                <MetricLabel>Rise Time (90%)</MetricLabel>
                <MetricValue>{fmtMs(liveSnapshot.riseTimeMs)}</MetricValue>
              </MetricBox>
              <MetricBox>
                <MetricLabel>Overshoot</MetricLabel>
                <MetricValue>
                  {liveSnapshot.mode === "v"
                    ? fmtPct(liveSnapshot.overshootPct)
                    : fmtAbs(liveSnapshot.overshootAbs, "p")}
                </MetricValue>
              </MetricBox>
              <MetricBox>
                <MetricLabel>Settling Time</MetricLabel>
                <MetricValue>{fmtMs(liveSnapshot.settlingTimeMs)}</MetricValue>
              </MetricBox>
              <MetricBox>
                <MetricLabel>Elapsed</MetricLabel>
                <MetricValue>{fmtMs(liveSnapshot.elapsedMs)}</MetricValue>
              </MetricBox>
            </MetricsRow>
          )}
        </ChartCard>

        {/* ============ History Table ============ */}
        <ChartCard>
          <CardTitleRow>
            <CardTitle>Step Response — History</CardTitle>
            <ClearButton onClick={clearHistory} disabled={history.length === 0}>
              Clear
            </ClearButton>
          </CardTitleRow>
          {history.length === 0 ? (
            <EmptyHint>
              ยังไม่มีประวัติ — แต่ละครั้งที่เปลี่ยน target จะถูกบันทึกหลัง step
              นิ่ง
            </EmptyHint>
          ) : (
            <TableWrap>
              <HistoryTable>
                <thead>
                  <tr>
                    <th>เวลา</th>
                    <th>Mode</th>
                    <th>Target</th>
                    <th>Kp / Ki / Kd</th>
                    <th>Rise</th>
                    <th>Overshoot</th>
                    <th>Settling</th>
                    <th>สถานะ</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.startedAt}</td>
                      <td>
                        <ModeTag $mode={h.mode}>
                          {h.mode === "v" ? "Velocity" : "Position"}
                        </ModeTag>
                      </td>
                      <td>{fmtTarget(h.target, h.mode)}</td>
                      <td className="mono">
                        {h.kp.toFixed(2)}/{h.ki.toFixed(2)}/{h.kd.toFixed(3)}
                      </td>
                      <td>{fmtMs(h.riseTimeMs)}</td>
                      <td>
                        {h.mode === "v"
                          ? fmtPct(h.overshootPct)
                          : fmtAbs(h.overshootAbs, "p")}
                      </td>
                      <td>{fmtMs(h.settlingTimeMs)}</td>
                      <td>
                        <SettledTag $settled={h.settled}>
                          {h.settled ? "Settled" : "Cut off"}
                        </SettledTag>
                      </td>
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
// Styled Components
// ===================================================================
const MainSection = styled.div`
  background: #0a0f1e;
  padding: 40px 20px;
  margin-top: 80px;
  min-height: 100vh;
  display: flex;
  justify-content: center;
`;
const MainBox = styled.div`
  width: 100%;
  max-width: 960px;
  display: flex;
  flex-direction: column;
  gap: 16px;
`;
const Header = styled.div`
  text-align: center;
  color: #ffdc7c;
`;
const Title = styled.h1`
  margin: 0;
  font-size: 1.6rem;
  letter-spacing: 0.06em;
`;
const StatusRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 8px;
`;
const StatusDot = styled.span<{ $ok: boolean }>`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${(p) => (p.$ok ? "#28a745" : "#dc3545")};
  box-shadow: ${(p) => (p.$ok ? "0 0 6px #28a745" : "none")};
`;
const StatusText = styled.span`
  font-size: 0.75rem;
  color: #cfd6e8;
`;
const TargetBadge = styled.span`
  font-size: 0.7rem;
  background: #28a745;
  color: #fff;
  padding: 2px 8px;
  border-radius: 10px;
`;
const ReadoutRow = styled.div`
  display: flex;
  gap: 8px;
`;
const ReadoutItem = styled.div`
  flex: 1;
  background: #0d1f4a;
  border: 1px solid #1e3a7a;
  border-radius: 8px;
  padding: 10px 12px;
  text-align: center;
`;
const ReadoutLabel = styled.div`
  font-size: 0.65rem;
  color: #ffdc7c;
  text-transform: uppercase;
  letter-spacing: 0.04em;
`;
const ReadoutValue = styled.div`
  font-size: 1.05rem;
  color: #fff;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
`;

const ChartCard = styled.div`
  background: #0d1f4a;
  border: 1px solid #1e3a7a;
  padding: 14px 16px;
  border-radius: 8px;
`;
const CardTitle = styled.div`
  color: #fff;
  margin-bottom: 8px;
  font-weight: bold;
  font-size: 0.9rem;
`;
const CardTitleRow = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
`;
const ChartLegendRow = styled.div`
  display: flex;
  align-items: center;
  font-size: 0.72rem;
  color: #cfd6e8;
`;
const LegendDot = styled.span<{ $c: string }>`
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: ${(p) => p.$c};
  margin-right: 4px;
`;
const TwoCol = styled.div`
  display: flex;
  gap: 16px;
  @media (max-width: 600px) {
    flex-direction: column;
  }
`;
const ControlCard = styled.div`
  flex: 1;
  background: #0d1f4a;
  border: 1px solid #1e3a7a;
  padding: 16px;
  border-radius: 8px;
`;
const ControlLabel = styled.div`
  color: #ffdc7c;
  font-size: 0.78rem;
  margin: 8px 0 4px;
`;
const ControlInput = styled.input`
  width: 100%;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid #2a4a8a;
  background: #06102a;
  color: #fff;
  font-size: 1rem;
  box-sizing: border-box;
`;
const ControlButton = styled.button`
  width: 100%;
  padding: 9px;
  margin-top: 10px;
  border-radius: 4px;
  border: none;
  background: #1a56db;
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  &:hover {
    background: #2563eb;
  }
`;
const StopButton = styled.button`
  width: 100%;
  padding: 9px;
  margin-top: 6px;
  border-radius: 4px;
  border: none;
  background: #b91c1c;
  color: #fff;
  font-weight: bold;
  cursor: pointer;
  &:hover {
    background: #dc2626;
  }
`;
const ModeToggleRow = styled.div`
  display: flex;
  gap: 6px;
  margin-bottom: 10px;
`;
const ModeBtn = styled.button<{ $active: boolean }>`
  flex: 1;
  padding: 7px;
  border-radius: 4px;
  border: 1px solid #2a4a8a;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: bold;
  background: ${(p) => (p.$active ? "#1e3a7a" : "transparent")};
  color: ${(p) => (p.$active ? "#00e6ff" : "#8899bb")};
`;

// Slider
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
const SliderNum = styled.span`
  font-size: 0.85rem;
  color: #fff;
  font-variant-numeric: tabular-nums;
  background: #06102a;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid #2a4a8a;
`;
const StyledRange = styled.input<{ $color: string }>`
  width: 100%;
  margin: 4px 0 2px;
  accent-color: ${(p) => p.$color};
`;
const SliderMinMax = styled.div`
  display: flex;
  justify-content: space-between;
  font-size: 0.6rem;
  color: #556;
`;
const PidManualRow = styled.div`
  display: flex;
  gap: 6px;
  margin-top: 8px;
`;
const PidInput = styled.input`
  flex: 1;
  padding: 5px;
  border-radius: 4px;
  border: 1px solid #2a4a8a;
  background: #06102a;
  color: #fff;
  font-size: 0.8rem;
  text-align: center;
`;
const SliderHint = styled.span`
  font-size: 0.65rem;
  color: #8899bb;
  font-weight: normal;
  margin-left: 6px;
`;

// Step Response
const LiveStateBadge = styled.span<{ $settled: boolean }>`
  font-size: 0.7rem;
  font-weight: bold;
  padding: 3px 10px;
  border-radius: 10px;
  color: #fff;
  background: ${(p) => (p.$settled ? "#28a745" : "#d99a1b")};
`;
const EmptyHint = styled.div`
  color: #556;
  font-size: 0.8rem;
  padding: 8px 0;
`;
const MetricsRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
`;
const MetricBox = styled.div`
  flex: 1;
  min-width: 100px;
  background: #06102a;
  border: 1px solid #1e3a7a;
  border-radius: 6px;
  padding: 10px 12px;
  text-align: center;
`;
const MetricLabel = styled.div`
  font-size: 0.6rem;
  color: #ffdc7c;
  margin-bottom: 4px;
  text-transform: uppercase;
  letter-spacing: 0.03em;
`;
const MetricValue = styled.div`
  font-size: 1rem;
  color: #fff;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
`;
const ClearButton = styled.button`
  background: transparent;
  border: 1px solid #4a5a8c;
  color: #cfd6e8;
  font-size: 0.7rem;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  &:hover:not(:disabled) {
    border-color: #dc3545;
    color: #dc3545;
  }
  &:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
`;
const TableWrap = styled.div`
  overflow-x: auto;
  max-height: 280px;
  overflow-y: auto;
`;
const HistoryTable = styled.table`
  width: 100%;
  border-collapse: collapse;
  font-size: 0.76rem;
  color: #e6eaf5;
  th,
  td {
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  }
  th {
    color: #ffdc7c;
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    position: sticky;
    top: 0;
    background: #0d1f4a;
  }
  td.mono {
    font-variant-numeric: tabular-nums;
    font-family: "Consolas", monospace;
  }
`;
const ModeTag = styled.span<{ $mode: "v" | "p" }>`
  font-size: 0.65rem;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 8px;
  color: #122049;
  background: ${(p) => (p.$mode === "v" ? "#00e6ff" : "#ffcc00")};
`;
const SettledTag = styled.span<{ $settled: boolean }>`
  font-size: 0.65rem;
  font-weight: bold;
  color: ${(p) => (p.$settled ? "#28a745" : "#dc3545")};
`;

export default MainPartSection;
