import { useCallback } from "react";
import { connectMQTT, publishMQTTJson } from "../lib/mqttClient";

export function useMqttControl() {
  connectMQTT();

  // ส่งค่าเป้าหมาย (Mode V หรือ P) -> topic เดียว "cmd/target"
  // payload: { mode: "v" | "p", value: number }
  // ตรงกับฝั่ง ESP32: callback() อ่าน doc["mode"] และ doc["value"] จาก topic นี้
  const sendTarget = useCallback((mode: "v" | "p", target: number) => {
    publishMQTTJson("cmd/target", { mode, value: target });
  }, []);

  // ส่งค่า PID ชุดเดียวใช้ร่วมกันทั้งสองโหมด -> topic เดียว "cmd/pid"
  // payload: { kp, ki, kd }
  // ตรงกับฝั่ง ESP32: callback() อ่าน doc["kp"], doc["ki"], doc["kd"] จาก topic นี้
  const sendPID = useCallback((kp: number, ki: number, kd: number) => {
    publishMQTTJson("cmd/pid", { kp, ki, kd });
  }, []);

  return { sendTarget, sendPID };
}
