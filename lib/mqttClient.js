import mqtt from "mqtt";

let client;

export function connectMQTT() {
  if (!client) {
    client = mqtt.connect(
      "wss://0d495914d04845f5914e55fd3e65c6e4.s1.eu.hivemq.cloud:8884/mqtt",
      {
        username: "hivemq.webclient.1756230627337",
        password: "!MN.8uI9x2GAvdJf#,1w",
        clean: true,
        reconnectPeriod: 1000, // reconnect อัตโนมัติทุก 1 วิ
      }
    );

    client.on("connect", () => {
      console.log("✅ MQTT Connected");
      // Subscribe ข้อมูลจาก ESP32 ตัวเดียวจบ
      client.subscribe("telemetry/data");
    });

    client.on("error", (err) => console.error("❌ MQTT Error:", err));
  }
  return client;
}

// publish ค่า primitive (string/number)
export function publishMQTT(topic, message) {
  if (client?.connected) {
    client.publish(topic, message.toString());
  }
}

// publish object เป็น JSON string (ใช้กับ cmd/target, cmd/pid)
export function publishMQTTJson(topic, payload) {
  if (client?.connected) {
    client.publish(topic, JSON.stringify(payload));
  }
}
