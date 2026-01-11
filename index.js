const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

/* ================== OPEN WEATHER ================== */
const API_KEY = "a216f02f9004f6fedecea80b73fc8632";
const CITY = "Da Nang";

/* ================== DATA ESP ================== */
let sensorData = {
  temperature: null,
  humidity: null,
  rainStatus: null,
  dustDensity: null,
  co2Level: null,
  uvIndex: null,
  lastUpdate: 0
};

/* ================== NHẬN ESP ================== */
app.post('/update-sensor', (req, res) => {
  sensorData = {
    ...req.body,
    lastUpdate: Date.now()
  };
  console.log("📡 ESP32:", sensorData);
  res.sendStatus(200);
});

/* ================== API CHO WEB ================== */
app.get('/my-station', async (req, res) => {
  try {
    /* ===== LẤY OPEN WEATHER ===== */
    const currentRes = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${CITY}&units=metric&appid=${API_KEY}&lang=vi`
    );

    const forecastRes = await axios.get(
      `https://api.openweathermap.org/data/2.5/forecast?q=${CITY}&units=metric&appid=${API_KEY}&lang=vi`
    );

    const owCurrent = currentRes.data;
    const owForecast = forecastRes.data;

    /* ===== SO SÁNH HIỆN TẠI ===== */
    const comparison = {
      temperatureDiff: diff(sensorData.temperature, owCurrent.main.temp),
      humidityDiff: diff(sensorData.humidity, owCurrent.main.humidity),
      rainMatch: compareRain(sensorData.rainStatus, owCurrent.weather[0].main),
    };

    /* ===== DỰ BÁO 4 NGÀY (HIỆU CHỈNH THEO TRẠM) ===== */
    const daily = {};
    owForecast.list.forEach(item => {
      const date = new Date(item.dt * 1000).toLocaleDateString('vi-VN');
      if (!daily[date]) {
        daily[date] = { temp: [], hum: [], weather: item.weather[0].main };
      }
      daily[date].temp.push(item.main.temp);
      daily[date].hum.push(item.main.humidity);
    });

    const forecast4Days = Object.keys(daily).slice(0, 4).map(date => {
      const avgTemp = avg(daily[date].temp);
      const avgHum = avg(daily[date].hum);

      /* 🔥 HIỆU CHỈNH = TRUNG BÌNH ESP + OPEN WEATHER */
      const finalTemp = sensorData.temperature
        ? (sensorData.temperature + avgTemp) / 2
        : avgTemp;

      const finalHum = sensorData.humidity
        ? (sensorData.humidity + avgHum) / 2
        : avgHum;

      return {
        date,
        temperature: Math.round(finalTemp),
        humidity: Math.round(finalHum),
        weather: daily[date].weather,
        rainChance: calcRainChance(finalTemp, finalHum),
        airQuality: assessAir(sensorData.dustDensity || 0)
      };
    });

    /* ===== TRẢ KẾT QUẢ ===== */
    res.json({
      station: sensorData,
      openWeather: {
        temp: owCurrent.main.temp,
        humidity: owCurrent.main.humidity,
        weather: owCurrent.weather[0].description
      },
      comparison,
      forecast4Days
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Lỗi dự báo" });
  }
});

/* ================== HÀM PHỤ ================== */
function avg(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function diff(a, b) {
  if (a == null) return null;
  return Math.abs(a - b).toFixed(1);
}

function compareRain(esp, ow) {
  const espRain = esp === 0;
  const owRain = ow === "Rain" || ow === "Drizzle";
  return espRain === owRain ? "PHÙ HỢP" : "KHÔNG KHỚP";
}

function calcRainChance(temp, hum) {
  let p = 0;
  if (hum > 80) p += 50;
  if (temp < 25 && hum > 70) p += 30;
  return Math.min(100, p);
}

function assessAir(dust) {
  if (dust < 35) return "TỐT";
  if (dust < 75) return "TRUNG BÌNH";
  return "Ô NHIỄM";
}

/* ================== SERVER ================== */
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("🚀 Server chạy cổng", PORT);
});
