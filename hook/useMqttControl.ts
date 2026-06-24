import { useCallback } from "react";
import { connectMQTT, publishMQTTJson } from "../lib/mqttClient";

export function useMqttControl() {
  connectMQTT();

  const sendTarget = useCallback((mode: "v" | "p", target: number) => {
    publishMQTTJson("cmd/target", { mode, value: target });
  }, []);

  const sendPID = useCallback((kp: number, ki: number, kd: number) => {
    publishMQTTJson("cmd/pid", { kp, ki, kd });
  }, []);

  // ส่งคำสั่งเริ่ม Auto-tune ไปยัง ESP32
  const startAutoTune = useCallback(() => {
    publishMQTTJson("cmd/autotune", { trigger: true });
  }, []);

  return { sendTarget, sendPID, startAutoTune };
}