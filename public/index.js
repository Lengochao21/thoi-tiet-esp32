const API_KEY = "a216f02f9004f6fedecea80b73fc8632";

let stationTimer = null;
let otherTimer = null;

const stationChartRef = { current: null };
const otherChartRef = { current: null };

function getWeatherIcon(weather) {
  const icons = {
    Clear: "☀️",
    Clouds: "☁️",
    Rain: "🌧️",
    Thunderstorm: "⛈️",
    Snow: "❄️",
    Mist: "🌫️",
  };
  return icons[weather] || "🌤️";
}

function setEspStatus(online) {
  const dot = document.getElementById("espStatus");
  const txt = document.getElementById("espStatusText");
  if (!dot || !txt) return;

  if (online) {
    dot.classList.add("connected");
    txt.innerText = "ESP: Đã kết nối";
  } else {
    dot.classList.remove("connected");
    txt.innerText = "✗ ESP: Mất kết nối";
  }
}

function uvText(uv) {
  if (uv <= 2) return "✅ An toàn";
  if (uv <= 5) return "⚠️ Bình thường";
  if (uv <= 7) return "⚠️ Cao";
  if (uv <= 10) return "🚨 Rất cao";
  return "☠️ Cực nguy hiểm";
}

function aqiText(aqi) {
  if (aqi <= 50) return "✅ Tốt";
  if (aqi <= 100) return "⚠️ Trung bình";
  if (aqi <= 150) return "⚠️ Kém";
  return "🚨 Xấu";
}

function initOrUpdateChart(canvasId, chartRef, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  if (!chartRef.current) {
    chartRef.current = new Chart(ctx, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Nhiệt độ (°C)",
            data,
            borderColor: "#f59e0b",
            backgroundColor: "rgba(245, 158, 11, 0.2)",
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 5,
            pointBorderColor: "#fff",
            pointBorderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { labels: { color: "#f8fafc" } },
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.7)",
            padding: 12,
            cornerRadius: 8,
            titleColor: "#fff",
            bodyColor: "#fff",
            callbacks: {
              label: (context) => context.parsed.y.toFixed(1) + "°C",
            },
          },
        },
        scales: {
          y: {
            grid: { color: "rgba(255,255,255,0.1)" },
            ticks: { color: "#f8fafc" },
          },
          x: {
            grid: { color: "rgba(255,255,255,0.1)" },
            ticks: { color: "#f8fafc" },
          },
        },
      },
    });
  } else {
    chartRef.current.data.labels = labels;
    chartRef.current.data.datasets[0].data = data;
    chartRef.current.update();
  }
}

async function loadForecastFor(city, gridId, chartCanvasId, chartRef) {
  const forecastUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(
    city
  )}&units=metric&appid=${API_KEY}&lang=vi`;

  const forecastRes = await fetch(forecastUrl);
  const forecastData = await forecastRes.json();

  const grid = document.getElementById(gridId);
  if (!grid) return;
  grid.innerHTML = "";

  const daily = {};
  (forecastData.list || []).forEach((item) => {
    const date = new Date(item.dt * 1000).toLocaleDateString("vi-VN");
    if (!daily[date]) daily[date] = item;
  });

  Object.keys(daily)
    .slice(0, 4)
    .forEach((date) => {
      const item = daily[date];
      const card = document.createElement("div");
      card.className = "forecast-card";
      card.innerHTML = `
        <div class="forecast-day">${date}</div>
        <div class="forecast-icon">${getWeatherIcon(item.weather[0].main)}</div>
        <div class="forecast-temp">${Math.round(item.main.temp)}°C</div>
        <div class="forecast-info">${Math.round(item.main.temp_min)}° ~ ${Math.round(
        item.main.temp_max
      )}°</div>
      `;
      grid.appendChild(card);
    });

  const chartData = [];
  const chartLabels = [];
  (forecastData.list || []).slice(0, 8).forEach((item) => {
    const time = new Date(item.dt * 1000).toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    chartLabels.push(time);
    chartData.push(item.main.temp);
  });

  initOrUpdateChart(chartCanvasId, chartRef, chartLabels, chartData);
}

async function loadStation1() {
  try {
    const res = await fetch("/get-sensor");
    if (!res.ok) throw new Error("get-sensor error");
    const data = await res.json();

    // ESP status chuẩn: dựa espOnline
    setEspStatus(!!data.espOnline);

    if (!data.espOnline) {
      // Offline: hiển thị rõ ràng
      document.getElementById("sensorTemp").innerText = "--";
      document.getElementById("sensorHumidity").innerText = "--";
      document.getElementById("sensorDust").innerText = "--";
      document.getElementById("sensorCO2").innerText = "--";
      document.getElementById("sensorRain").innerText = "--";
      document.getElementById("aqiValue").innerText = "--";
      document.getElementById("aqiBadge").innerText = "ESP offline";
      document.getElementById("uvIndex").innerText = "--";
      document.getElementById("uvDesc").innerText = "ESP offline";
      document.getElementById("mainTemp").innerText = "--";
      document.getElementById("mainCondition").innerText = "KHÔNG KẾT NỐI TRẠM";
      document.getElementById("weatherIcon").innerText = "❌";
      return;
    }

    const t = Number(data.temperature || 0);
    const h = Number(data.humidity || 0);
    const dust = Number(data.dustDensity || 0);
    const aqi = Number(data.co2Level || 0); // AQI nằm ở co2Level
    const uv = Number(data.uvIndex || 0);
    const rain = Number(data.rainStatus || 0);

    document.getElementById("sensorTemp").innerText = Math.round(t);
    document.getElementById("sensorHumidity").innerText = Math.round(h);
    document.getElementById("sensorDust").innerText = dust.toFixed(1);

    // MQ-135: chỉ hiển thị AQI (không NH3)
    document.getElementById("sensorCO2").innerText = Math.round(aqi);
    document.getElementById("airQuality").innerText = aqiText(aqi);

    // FIX mưa/khô theo ESP: rain=1 => MƯA
    document.getElementById("sensorRain").innerText =
      rain === 1 ? "🌧️ MƯA" : "☀️ KHÔ";

    // AQI box
    document.getElementById("aqiValue").innerText = Math.round(aqi);
    document.getElementById("aqiBadge").innerText = aqiText(aqi);

    // UV
    document.getElementById("uvIndex").innerText = uv.toFixed(1);
    document.getElementById("uvDesc").innerText = uvText(uv);

    // Hero
    document.getElementById("mainTemp").innerText = t.toFixed(1); // HTML đã có °C bên ngoài
    document.getElementById("feelsLike").innerText = Math.round(t - 2);
    document.getElementById("pressure").innerText = 1013;
    document.getElementById("mainCondition").innerText = rain === 1 ? "Mưa" : "Khô";
    document.getElementById("weatherIcon").innerText = rain === 1 ? "🌧️" : "⛅";

    // Forecast cho trạm 1 luôn lấy Đà Nẵng
    await loadForecastFor("Da Nang", "forecastGrid", "forecastChart", stationChartRef);
  } catch (e) {
    console.error(e);
    setEspStatus(false);
    document.getElementById("mainCondition").innerText = "KHÔNG KẾT NỐI ĐƯỢC TRẠM";
  }
}

async function loadOtherLocation(city) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      city
    )}&units=metric&appid=${API_KEY}&lang=vi`;

    const res = await fetch(url);
    const data = await res.json();

    document.getElementById("otherLocationName").innerText = data.name;
    document.getElementById("otherMainTemp").innerText = Math.round(data.main.temp);
    document.getElementById("otherMainCondition").innerText = data.weather[0].description;
    document.getElementById("otherWeatherIcon").innerText = getWeatherIcon(data.weather[0].main);
    document.getElementById("otherHumidity").innerText = data.main.humidity;
    document.getElementById("otherWind").innerText = data.wind.speed.toFixed(1);

    document.getElementById("visibility").innerText = (data.visibility / 1000).toFixed(1);
    document.getElementById("clouds").innerText = data.clouds.all;

    await loadForecastFor(city, "otherForecastGrid", "otherForecastChart", otherChartRef);
  } catch (e) {
    console.error("Other city error:", e);
  }
}

function startStationPolling() {
  stopOtherPolling();
  loadStation1();
  if (!stationTimer) stationTimer = setInterval(loadStation1, 10000);
}

function stopStationPolling() {
  if (stationTimer) {
    clearInterval(stationTimer);
    stationTimer = null;
  }
}

function startOtherPolling(city) {
  stopStationPolling();
  loadOtherLocation(city);
  if (otherTimer) clearInterval(otherTimer);
  otherTimer = setInterval(() => loadOtherLocation(city), 60000);
}

function stopOtherPolling() {
  if (otherTimer) {
    clearInterval(otherTimer);
    otherTimer = null;
  }
}

// Select change
document.getElementById("locationSelect").addEventListener("change", (e) => {
  if (e.target.value === "station1") {
    document.getElementById("station1Section").style.display = "block";
    document.getElementById("otherLocationSection").style.display = "none";
    startStationPolling();
  } else {
    document.getElementById("station1Section").style.display = "none";
    document.getElementById("otherLocationSection").style.display = "block";
    startOtherPolling(e.target.value);
  }
});

// Search Enter
document.getElementById("citySearch").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    const city = e.target.value.trim();
    if (!city) return;

    document.getElementById("station1Section").style.display = "none";
    document.getElementById("otherLocationSection").style.display = "block";
    startOtherPolling(city);
  }
});

// Start
startStationPolling();
