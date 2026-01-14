// ======================== IMPORT ========================
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ======================== CONFIG ========================
const API_KEY = process.env.OPENWEATHER_API_KEY || "a216f02f9004f6fedecea80b73fc8632";
const CITY = process.env.CITY || "Da Nang";

// ======================== SENSOR DATA ========================
let sensorData = {
    temperature: 0,
    humidity: 0,
    dustDensity: 0,
    co2Level: 0,
    rainStatus: 1,
    uvIndex: 0,
    lastUpdate: 0
};

// ======================== ESP32 PUSH DATA ========================
app.post('/update-sensor', (req, res) => {
    sensorData = {
        ...req.body,
        lastUpdate: Date.now()
    };
    console.log("📡 ESP32:", sensorData);
    res.sendStatus(200);
});

// ======================== API LẤY DATA ESP ========================
app.get('/get-sensor', (req, res) => {
    res.json(sensorData);
});

// ======================== CORE API (AI + DỰ BÁO) ========================
app.get('/predict-station1', async (req, res) => {
    try {
        const ow = await axios.get(
            `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&units=metric&appid=${API_KEY}&lang=vi`
        );

        const tempOW = ow.data.main.temp;
        const humOW = ow.data.main.humidity;
        const weather = ow.data.weather[0].main;

        const tempESP = sensorData.temperature;
        const humESP = sensorData.humidity;

        const accuracyTemp = calcAccuracy(tempESP, tempOW, 10);
        const accuracyHum = calcAccuracy(humESP, humOW, 2);

        const rainChance = calcRainChance(tempESP, humESP);
        const recommendation = getRecommendation(tempESP, weather, rainChance);

        res.json({
            espData: sensorData,
            openWeatherData: {
                temp: Math.round(tempOW),
                humidity: humOW,
                weather,
                description: ow.data.weather[0].description
            },
            comparison: {
                temperature: accuracyTemp,
                humidity: accuracyHum
            },
            predictionToday: {
                rainChance,
                recommendation,
                confidence: Math.round((accuracyTemp + accuracyHum) / 2)
            }
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "OpenWeather error" });
    }
});

// ======================== FUNCTIONS ========================
function calcAccuracy(esp, ow, factor) {
    const diff = Math.abs(esp - ow);
    return Math.max(0, 100 - diff * factor);
}

function calcRainChance(temp, hum) {
    let chance = 0;
    if (hum > 80) chance += 60;
    if (temp < 25) chance += 20;
    return Math.min(100, chance);
}

function getRecommendation(temp, weather, rainChance) {
    if (rainChance > 70) return "☔ Khả năng mưa cao";
    if (temp > 35) return "🔥 Nắng nóng";
    if (weather === 'Clear') return "☀️ Trời nắng";
    return "✅ Thời tiết ổn định";
}

// ======================== SERVER ========================
const PORT = process.env.PORT || 14001;
app.listen(PORT, '0.0.0.0', () =>
    console.log("running on http://localhost:" + PORT)
);
