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
        reconnectPeriod: 1000, 
      }
    );

    client.on("connect", () => {
      console.log("✅ MQTT Connected");
      client.subscribe("telemetry/data");
      // Subscribe รับค่า PID ที่จูนเสร็จจาก ESP32
      client.subscribe("telemetry/pid_updated"); 
    });

    client.on("error", (err) => console.error("❌ MQTT Error:", err));
  }
  return client;
}

export function publishMQTT(topic, message) {
  if (client?.connected) {
    client.publish(topic, message.toString());
  }
}

export function publishMQTTJson(topic, payload) {
  if (client?.connected) {
    client.publish(topic, JSON.stringify(payload), { retain: true });
  }
}