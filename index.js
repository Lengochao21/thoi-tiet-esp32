const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const API_KEY =
    process.env.OPENWEATHER_API_KEY || "a216f02f9004f6fedecea80b73fc8632";
const CITY = process.env.CITY || "Da Nang";

let sensorData = {
    temperature: 0,
    humidity: 0,
    dustDensity: 0,
    co2Level: 0, // ESP đang gửi AQI vào đây
    rainStatus: 0, // ESP: 1 = MƯA, 0 = KHÔ (theo code ESP bạn in Serial)
    uvIndex: 0,
    lastUpdate: 0,
};

// ESP32 push
app.post("/update-sensor", (req, res) => {
    const b = req.body || {};
    sensorData = {
        temperature: Number(b.temperature ?? sensorData.temperature ?? 0),
        humidity: Number(b.humidity ?? sensorData.humidity ?? 0),
        dustDensity: Number(b.dustDensity ?? sensorData.dustDensity ?? 0),
        co2Level: Number(b.co2Level ?? sensorData.co2Level ?? 0),
        rainStatus: Number(b.rainStatus ?? sensorData.rainStatus ?? 0),
        uvIndex: Number(b.uvIndex ?? sensorData.uvIndex ?? 0),
        lastUpdate: Date.now(),
    };

    console.log("📡 ESP32:", sensorData);
    res.sendStatus(200);
});

// GET sensor + trạng thái online/offline chuẩn
app.get("/get-sensor", (req, res) => {
    const now = Date.now();
    const ageMs = now - (sensorData.lastUpdate || 0);
    const espOnline = !!sensorData.lastUpdate && ageMs <= 15000; // >15s coi như offline

    res.json({
        ...sensorData,
        espOnline,
        ageMs,
    });
});

// ====== API so sánh + dự báo (tùy bạn dùng) ======
async function buildPrediction() {
    const ow = await axios.get(
        `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
            CITY
        )}&units=metric&appid=${API_KEY}&lang=vi`
    );

    const tempOW = ow.data?.main?.temp ?? 0;
    const humOW = ow.data?.main?.humidity ?? 0;
    const owMain = ow.data?.weather?.[0]?.main ?? "Unknown";
    const owDesc = ow.data?.weather?.[0]?.description ?? "";

    const tempESP = sensorData.temperature ?? 0;
    const humESP = sensorData.humidity ?? 0;

    const accuracyTemp = calcAccuracyByTolerance(tempESP, tempOW, 3.0);
    const accuracyHum = calcAccuracyByTolerance(humESP, humOW, 15);

    const rainChance = calcRainChance(
        tempESP,
        humESP,
        sensorData.rainStatus,
        owMain
    );
    const recommendation = getRecommendation(tempESP, owMain, rainChance);

    return {
        espData: sensorData,
        openWeatherData: {
            temp: Math.round(tempOW),
            humidity: humOW,
            weather: owMain,
            description: owDesc,
        },
        comparison: {
            temperature: accuracyTemp,
            humidity: accuracyHum,
        },
        predictionToday: {
            rainChance,
            recommendation,
            confidence: Math.round((accuracyTemp + accuracyHum) / 2),
        },
    };
}

app.get("/predict-station1", async (req, res) => {
    try {
        res.json(await buildPrediction());
    } catch (err) {
        console.error(err?.response?.data || err);
        res.status(500).json({ error: "OpenWeather error" });
    }
});

// Alias cho frontend cũ nếu còn gọi /forecast-ai
app.get("/forecast-ai", async (req, res) => {
    try {
        res.json(await buildPrediction());
    } catch (err) {
        console.error(err?.response?.data || err);
        res.status(500).json({ error: "Forecast AI error" });
    }
});

function calcAccuracyByTolerance(esp, ow, tol) {
    const diff = Math.abs((esp ?? 0) - (ow ?? 0));
    const score = 100 * Math.max(0, 1 - diff / tol);
    return Math.round(Math.min(100, score));
}

function calcRainChance(temp, hum, rainStatus, owMain) {
    if (rainStatus === 1) return 95;

    let chance = 0;
    if (hum > 85) chance += 45;
    else if (hum > 75) chance += 25;
    else if (hum > 65) chance += 10;

    if (owMain === "Rain" || owMain === "Thunderstorm") chance += 40;
    else if (owMain === "Clouds") chance += 15;

    if (temp < 24) chance += 10;

    return Math.min(100, chance);
}

function getRecommendation(temp, owMain, rainChance) {
    if (rainChance >= 80) return "☔ Khả năng mưa cao";
    if (temp >= 35) return "🔥 Nắng nóng";
    if (owMain === "Clear") return "☀️ Trời nắng";
    if (owMain === "Clouds") return "⛅ Nhiều mây";
    return "✅ Thời tiết ổn định";
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () =>
    console.log("running on http://localhost:" + PORT)
);
