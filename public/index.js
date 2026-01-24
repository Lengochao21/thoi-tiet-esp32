// /public/index.js
// - Giữ forecast + station realtime + other city
// - Lịch sử: mở modal (Lịch sử) -> 2 chart + bảng + phân trang
// - Chuông: xin quyền + đăng ký push (gửi subscription lên backend)
// - Chart tự đổi màu theo theme dựa trên body[data-theme]

const API_KEY = "a216f02f9004f6fedecea80b73fc8632";

let stationTimer = null;
let otherTimer = null;

const stationChartRef = { current: null };
const otherChartRef = { current: null };

// history charts
const historyTHRef = { current: null }; // temp + hum
const historyDARRef = { current: null }; // dust + aqi + rain

// history state
let historyRange = "1d"; // default for modal
let historyTimer = null;
let historyRowsCache = [];
let historyPage = 1;
const HISTORY_PAGE_SIZE = 10;

// ============== Helpers ==============
function $(id) {
  return document.getElementById(id);
}
function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.innerText = value;
}
function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
function isLightTheme() {
  return document.body.getAttribute("data-theme") === "light";
}
function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function fmtTime(iso) {
  const d = new Date(iso);
  if (!isFinite(d.getTime())) return "--";
  const hhmm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const ddmm = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  // range dài thì hiện dd/mm hh:mm, range 1d thì hh:mm
  if (historyRange === "7d" || historyRange === "3d") return `${ddmm} ${hhmm}`;
  return `${hhmm}`;
}

// ============== UI text ==============
function getWeatherIcon(weather) {
  const icons = {
    Clear: "☀️",
    Clouds: "☁️",
    Rain: "🌧️",
    Thunderstorm: "⛈️",
    Snow: "❄️",
    Mist: "🌫️",
    Smoke: "🌫️",
    Haze: "🌫️",
    Fog: "🌫️",
  };
  return icons[weather] || "🌤️";
}

function setEspStatus(online) {
  const dot = $("espStatus");
  const txt = $("espStatusText");
  if (!dot || !txt) return;

  if (online) {
    dot.classList.add("connected");
    txt.innerText = "ESP: Đã kết nối";
  } else {
    dot.classList.remove("connected");
    txt.innerText = "ESP: Mất kết nối";
  }
}

function uvText(uv) {
  if (uv <= 2) return "✅ An toàn";
  if (uv <= 5) return "⚠️ Bình thường";
  if (uv <= 7) return "⚠️ Cao";
  if (uv <= 10) return "🚨 Rất cao";
  return "☠️ Cực nguy hiểm";
}

// AQI kiểu 0-500 (dành cho ESP của bạn)
function aqiText(aqi) {
  if (aqi <= 50) return "✅ Tốt";
  if (aqi <= 100) return "🟡 Trung bình";
  if (aqi <= 150) return "⚠️ Kém/Không tốt";
  if (aqi <= 200) return "🚨 Không tốt cho SK";
  if (aqi <= 300) return "☠️ Rất không tốt";
  return "☠️ Nguy hại";
}

// PM2.5 theo thang bạn gửi (µg/m³)
function pm25Text(pm) {
  if (pm <= 12.0) return "✅ Tốt";
  if (pm <= 35.4) return "🟡 Trung bình";
  if (pm <= 55.4) return "⚠️ Kém/Không tốt";
  if (pm <= 150.4) return "🚨 Không tốt cho SK";
  if (pm <= 250.4) return "☠️ Rất không tốt";
  return "☠️ Nguy hại";
}

function badgeHtml(text) {
  // trả về 1 badge gọn
  // text đã có emoji đầu -> dùng màu đơn giản theo mức
  const t = String(text || "");
  let bg = "rgba(59,130,246,0.12)";
  let bd = "rgba(59,130,246,0.28)";
  if (t.includes("✅")) {
    bg = "rgba(16,185,129,0.18)";
    bd = "rgba(16,185,129,0.35)";
  } else if (t.includes("🟡")) {
    bg = "rgba(245,158,11,0.16)";
    bd = "rgba(245,158,11,0.32)";
  } else if (t.includes("⚠️")) {
    bg = "rgba(249,115,22,0.16)";
    bd = "rgba(249,115,22,0.32)";
  } else if (t.includes("🚨") || t.includes("☠️")) {
    bg = "rgba(239,68,68,0.16)";
    bd = "rgba(239,68,68,0.32)";
  }

  return `<span style="
    display:inline-flex;
    align-items:center;
    gap:6px;
    padding:4px 10px;
    border-radius:999px;
    font-weight:900;
    font-size:0.78rem;
    border:1px solid ${bd};
    background:${bg};
  ">${t.replace("✅", "").replace("🟡", "").replace("⚠️", "").replace("🚨", "").replace("☠️", "").trim()}</span>`;
}

// ============== Chart base (forecast) ==============
function initOrUpdateForecastChart(canvasId, chartRef, labels, data) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  const light = isLightTheme();
  const tickColor = light ? "#0f172a" : "#f8fafc";
  const gridColor = light ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.10)";

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
            backgroundColor: "rgba(245, 158, 11, 0.18)",
            borderWidth: 3,
            fill: true,
            tension: 0.4,
            pointRadius: 3,
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
          legend: { labels: { color: tickColor } },
          tooltip: {
            backgroundColor: "rgba(0,0,0,0.7)",
            padding: 12,
            cornerRadius: 8,
            titleColor: "#fff",
            bodyColor: "#fff",
            callbacks: {
              label: (context) => Number(context.parsed.y).toFixed(1) + "°C",
            },
          },
        },
        scales: {
          y: { grid: { color: gridColor }, ticks: { color: tickColor } },
          x: { grid: { color: gridColor }, ticks: { color: tickColor } },
        },
      },
    });
  } else {
    chartRef.current.data.labels = labels;
    chartRef.current.data.datasets[0].data = data;

    chartRef.current.options.plugins.legend.labels.color = tickColor;
    chartRef.current.options.scales.x.ticks.color = tickColor;
    chartRef.current.options.scales.y.ticks.color = tickColor;
    chartRef.current.options.scales.x.grid.color = gridColor;
    chartRef.current.options.scales.y.grid.color = gridColor;

    chartRef.current.update();
  }
}

// ============== Forecast (OpenWeather forecast) ==============
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

  initOrUpdateForecastChart(chartCanvasId, chartRef, chartLabels, chartData);
}

// ============== Station 1 (ESP) ==============
async function loadStation1() {
  try {
    const res = await fetch("/get-sensor");
    if (!res.ok) throw new Error("get-sensor error");
    const data = await res.json();

    // Forecast Đà Nẵng vẫn giữ
    loadForecastFor("Da Nang", "forecastGrid", "forecastChart", stationChartRef);

    setEspStatus(!!data.espOnline);

    if (!data.espOnline) {
      setText("sensorTemp", "--");
      setText("sensorHumidity", "--");
      setText("sensorDust", "--");
      setText("sensorCO2", "--");
      setText("sensorRain", "--");
      setText("aqiValue", "--");
      setText("aqiBadge", "ESP offline");
      setText("uvIndex", "--");
      setText("uvDesc", "ESP offline");
      setText("mainTemp", "--");
      setText("mainCondition", "KHÔNG KẾT NỐI TRẠM");
      setText("weatherIcon", "❌");
      return;
    }

    const t = safeNum(data.temperature, 0);
    const h = safeNum(data.humidity, 0);
    const dust = safeNum(data.dustDensity, 0);
    const aqi = safeNum(data.co2Level, 0); // AQI của ESP nằm ở co2Level
    const uv = safeNum(data.uvIndex, 0);
    const rain = safeNum(data.rainStatus, 0);

    setText("sensorTemp", String(Math.round(t)));
    setText("sensorHumidity", String(Math.round(h)));
    setText("sensorDust", dust.toFixed(1));

    setText("sensorCO2", String(Math.round(aqi)));
    setText("airQuality", aqiText(aqi));

    setText("sensorRain", rain === 1 ? "🌧️ MƯA" : "☀️ KHÔ");

    setText("aqiValue", String(Math.round(aqi)));
    setText("aqiBadge", aqiText(aqi));

    setText("uvIndex", uv.toFixed(1));
    setText("uvDesc", uvText(uv));

    setText("mainTemp", t.toFixed(1));
    setText("feelsLike", String(Math.round(t - 2)));
    setText("pressure", "1013");
    setText("mainCondition", rain === 1 ? "Mưa" : "Khô");
    setText("weatherIcon", rain === 1 ? "🌧️" : "⛅");
  } catch (e) {
    console.error(e);
    setEspStatus(false);
    setText("mainCondition", "KHÔNG KẾT NỐI ĐƯỢC TRẠM");
  }
}

// ============== Other location (CALL BACKEND METRICS) ==============
async function loadOtherLocation(city) {
  try {
    const res = await fetch(`/api/metrics?city=${encodeURIComponent(city)}`);
    const m = await res.json();
    if (!res.ok || m.error) throw new Error(m.error || "metrics error");

    setText("otherLocationName", m.city || city);

    if (m.weather) {
      setText("otherMainTemp", String(Math.round(m.weather.temp ?? 0)));
      setText("otherMainCondition", m.weather.description || "—");
      setText("otherWeatherIcon", getWeatherIcon(m.weather.main));

      setText("otherHumidity", String(m.weather.humidity ?? "--"));
      setText("otherWind", Number(m.weather.wind ?? 0).toFixed(1));

      setText(
        "visibility",
        typeof m.weather.visibility === "number"
          ? (m.weather.visibility / 1000).toFixed(1)
          : "--"
      );
      setText(
        "clouds",
        typeof m.weather.clouds === "number" ? String(m.weather.clouds) : "--"
      );
    }

    // UV (Open-Meteo)
    if (typeof m.uv?.uvi === "number") {
      setText("otherUvValue", m.uv.uvi.toFixed(1));
      setText("otherUvText", m.uv.text || uvText(m.uv.uvi));
    } else {
      setText("otherUvValue", "--");
      setText("otherUvText", "Không có dữ liệu UV");
    }

    // AQI/PM (OpenWeather air_pollution 1..5)
    if (typeof m.air?.aqi === "number") {
      setText("otherAqiValue", String(m.air.aqi));
      setText("otherAqiText", m.air.text || "—");
    } else {
      setText("otherAqiValue", "--");
      setText("otherAqiText", "Không có dữ liệu AQI");
    }

    const pm25 = m.air?.pm2_5;
    const pm10 = m.air?.pm10;
    setText(
      "otherPmText",
      `PM2.5: ${typeof pm25 === "number" ? pm25.toFixed(1) : "--"} µg/m³ • PM10: ${
        typeof pm10 === "number" ? pm10.toFixed(1) : "--"
      } µg/m³`
    );

    await loadForecastFor(city, "otherForecastGrid", "otherForecastChart", otherChartRef);
  } catch (e) {
    console.error("Other city error:", e);
  }
}

// ============== Polling ==============
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

// ============== Search dropdown ==============
const locations = [
  { id: "station1", name: "🔴 TRẠM 1 - KHU VỰC CHÍNH", type: "station" },
  { id: "Da Nang", name: "📍 Đà Nẵng", type: "city" },
  { id: "Hanoi", name: "Hà Nội", type: "city" },
  { id: "Ho Chi Minh", name: "TP. Hồ Chí Minh", type: "city" },
  { id: "Hue", name: "Huế", type: "city" },
  { id: "Nha Trang", name: "Nha Trang", type: "city" },
];

const searchInput = document.getElementById("searchInput");
const dropdownList = document.getElementById("dropdownList");

function renderDropdown(items) {
  if (!dropdownList) return;
  dropdownList.innerHTML = "";

  if (items.length === 0) {
    dropdownList.innerHTML =
      '<li class="dropdown-item" style="justify-content:center; opacity:0.7">Không tìm thấy</li>';
    return;
  }

  items.forEach((loc) => {
    const li = document.createElement("li");
    li.className = "dropdown-item";
    li.innerHTML = `
      <i class="${
        loc.type === "station" ? "fas fa-broadcast-tower" : "fas fa-map-marker-alt"
      }" style="color: ${
      loc.type === "station" ? "var(--danger)" : "var(--primary)"
    }"></i>
      <span>${loc.name}</span>
    `;
    li.onclick = () => selectLocation(loc);
    dropdownList.appendChild(li);
  });
}

function selectLocation(loc) {
  if (!searchInput || !dropdownList) return;

  searchInput.value = loc.name;
  dropdownList.classList.remove("show");

  if (loc.id === "station1") {
    if ($("station1Section")) $("station1Section").style.display = "block";
    if ($("otherLocationSection")) $("otherLocationSection").style.display = "none";
    startStationPolling();
  } else {
    if ($("station1Section")) $("station1Section").style.display = "none";
    if ($("otherLocationSection")) $("otherLocationSection").style.display = "block";
    startOtherPolling(loc.id);
  }
}

// ============== ✅ HISTORY (Modal) ==============
function rangeToQuery(range) {
  const now = Date.now();
  let fromMs = now - 24 * 60 * 60 * 1000; // 1d
  if (range === "3d") fromMs = now - 3 * 24 * 60 * 60 * 1000;
  if (range === "7d") fromMs = now - 7 * 24 * 60 * 60 * 1000;

  const from = new Date(fromMs).toISOString();
  const to = new Date(now).toISOString();

  // limit: vẫn clamp để tránh nặng
  // nếu rule lưu 1 phút/lần thì 1d ~1440, 3d ~4320, 7d ~10080
  let limit = 1500;
  if (range === "1d") limit = 1800;
  if (range === "3d") limit = 2500;
  if (range === "7d") limit = 3000;
  limit = clamp(limit, 200, 3000);

  return { from, to, limit };
}

function applyChartThemeOptions(chart, tickColor, gridColor) {
  if (!chart) return;
  // scales may differ
  const scales = chart.options?.scales || {};
  for (const k of Object.keys(scales)) {
    if (scales[k]?.ticks) scales[k].ticks.color = tickColor;
    if (scales[k]?.grid) scales[k].grid.color = gridColor;
    if (scales[k]?.title) scales[k].title.color = tickColor;
  }
  if (chart.options?.plugins?.legend?.labels) {
    chart.options.plugins.legend.labels.color = tickColor;
  }
}

function initOrUpdateHistoryCharts(labels, tempArr, humArr, dustArr, aqiArr, rainArr) {
  const light = isLightTheme();
  const tickColor = light ? "#0f172a" : "#f8fafc";
  const gridColor = light ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.10)";

  // ---- Chart 1: Temp + Hum
  const c1 = $("historyTempHumChart");
  if (c1) {
    const ctx1 = c1.getContext("2d");
    if (!historyTHRef.current) {
      historyTHRef.current = new Chart(ctx1, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Nhiệt độ (°C)",
              data: tempArr,
              borderColor: "#f59e0b",
              backgroundColor: "rgba(245,158,11,0.15)",
              borderWidth: 3,
              fill: false,
              tension: 0.35,
              pointRadius: 0,
              yAxisID: "y",
            },
            {
              label: "Độ ẩm (%)",
              data: humArr,
              borderColor: "#3b82f6",
              backgroundColor: "rgba(59,130,246,0.12)",
              borderWidth: 3,
              fill: false,
              tension: 0.35,
              pointRadius: 0,
              yAxisID: "y1",
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: tickColor } },
            tooltip: {
              backgroundColor: "rgba(0,0,0,0.7)",
              titleColor: "#fff",
              bodyColor: "#fff",
              callbacks: {
                label: (ctx) => {
                  const v = safeNum(ctx.parsed.y, 0);
                  if (ctx.dataset.label.includes("Nhiệt")) return `Nhiệt độ: ${v.toFixed(1)}°C`;
                  return `Độ ẩm: ${v.toFixed(0)}%`;
                },
              },
            },
          },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8 } },
            y: {
              grid: { color: gridColor },
              ticks: { color: tickColor },
              title: { display: true, text: "°C", color: tickColor },
            },
            y1: {
              position: "right",
              grid: { drawOnChartArea: false },
              ticks: { color: tickColor },
              title: { display: true, text: "%", color: tickColor },
            },
          },
        },
      });
    } else {
      historyTHRef.current.data.labels = labels;
      historyTHRef.current.data.datasets[0].data = tempArr;
      historyTHRef.current.data.datasets[1].data = humArr;

      applyChartThemeOptions(historyTHRef.current, tickColor, gridColor);
      historyTHRef.current.update();
    }
  }

  // ---- Chart 2: PM2.5 line + AQI line + Rain bar
  const c2 = $("historyDustRainChart");
  if (c2) {
    const ctx2 = c2.getContext("2d");

    // dynamic axis max
    const maxDust = Math.max(0, ...dustArr.map((x) => safeNum(x, 0)));
    const maxAqi = Math.max(0, ...aqiArr.map((x) => safeNum(x, 0)));
    const yDustMax = Math.max(50, Math.ceil((maxDust * 1.25 + 5) / 5) * 5);
    const yAqiMax = Math.max(100, Math.ceil((maxAqi * 1.25 + 10) / 10) * 10);

    if (!historyDARRef.current) {
      historyDARRef.current = new Chart(ctx2, {
        data: {
          labels,
          datasets: [
            {
              type: "line",
              label: "PM2.5 (µg/m³)",
              data: dustArr,
              borderColor: "#f97316",
              backgroundColor: "rgba(249,115,22,0.12)",
              borderWidth: 3,
              fill: false,
              tension: 0.35,
              pointRadius: 0,
              yAxisID: "yDust",
            },
            {
              type: "line",
              label: "AQI",
              data: aqiArr,
              borderColor: "#06b6d4",
              backgroundColor: "rgba(6,182,212,0.12)",
              borderWidth: 3,
              fill: false,
              tension: 0.35,
              pointRadius: 0,
              yAxisID: "yAqi",
            },
            {
              type: "bar",
              label: "Mưa (0/1)",
              data: rainArr,
              backgroundColor: "rgba(16,185,129,0.30)",
              borderColor: "rgba(16,185,129,0.55)",
              borderWidth: 1,
              yAxisID: "yRain",
              barPercentage: 1.0,
              categoryPercentage: 1.0,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { labels: { color: tickColor } },
            tooltip: {
              backgroundColor: "rgba(0,0,0,0.7)",
              titleColor: "#fff",
              bodyColor: "#fff",
              callbacks: {
                label: (ctx) => {
                  const v = safeNum(ctx.parsed.y, 0);
                  if (ctx.dataset.type === "bar") return `Mưa: ${v === 1 ? "Có" : "Không"}`;
                  if (ctx.dataset.label === "AQI") return `AQI: ${v.toFixed(0)} (${aqiText(v)})`;
                  return `PM2.5: ${v.toFixed(1)} (${pm25Text(v)})`;
                },
              },
            },
          },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8 } },
            yDust: {
              position: "left",
              min: 0,
              max: yDustMax,
              grid: { color: gridColor },
              ticks: { color: tickColor },
              title: { display: true, text: "PM2.5", color: tickColor },
            },
            yAqi: {
              position: "right",
              min: 0,
              max: yAqiMax,
              grid: { drawOnChartArea: false },
              ticks: { color: tickColor },
              title: { display: true, text: "AQI", color: tickColor },
            },
            yRain: {
              position: "right",
              min: 0,
              max: 1,
              grid: { drawOnChartArea: false },
              ticks: {
                color: tickColor,
                callback: (v) => (v === 1 ? "Mưa" : "Khô"),
              },
              title: { display: true, text: "Mưa", color: tickColor },
            },
          },
        },
      });
    } else {
      historyDARRef.current.data.labels = labels;
      historyDARRef.current.data.datasets[0].data = dustArr;
      historyDARRef.current.data.datasets[1].data = aqiArr;
      historyDARRef.current.data.datasets[2].data = rainArr;

      // update dynamic axis max
      historyDARRef.current.options.scales.yDust.max = yDustMax;
      historyDARRef.current.options.scales.yAqi.max = yAqiMax;

      applyChartThemeOptions(historyDARRef.current, tickColor, gridColor);
      historyDARRef.current.update();
    }
  }
}

function renderHistoryTable() {
  const body = $("historyTableBody");
  const info = $("historyPageInfo");
  if (!body) return;

  const total = historyRowsCache.length;
  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  historyPage = clamp(historyPage, 1, totalPages);

  const start = (historyPage - 1) * HISTORY_PAGE_SIZE;
  const end = Math.min(total, start + HISTORY_PAGE_SIZE);
  const pageRows = historyRowsCache.slice(start, end);

  if (info) info.innerText = `Trang ${historyPage} / ${totalPages} • Tổng ${total} mẫu`;

  if (pageRows.length === 0) {
    body.innerHTML = `
      <tr>
        <td colspan="7" style="opacity:.85; font-weight:900">Chưa có dữ liệu lịch sử (MongoDB).</td>
      </tr>`;
    return;
  }

  body.innerHTML = pageRows
    .map((r) => {
      const time = fmtTime(r.createdAt || r.updatedAt || r._id);
      const t = safeNum(r.temperature, 0);
      const h = safeNum(r.humidity, 0);
      const pm = safeNum(r.dustDensity, 0);
      const aqi = safeNum(r.co2Level ?? r.aqi ?? r.airQuality ?? 0, 0); // linh hoạt
      const uv = safeNum(r.uvIndex, 0);
      const rain = safeNum(r.rainStatus, 0) === 1 ? "Mưa" : "Khô";

      const pmLevel = pm25Text(pm);
      const aqiLevel = aqiText(aqi);

      return `
        <tr>
          <td style="font-weight:900">${time}</td>
          <td style="font-weight:900">${t.toFixed(1)}</td>
          <td style="font-weight:900">${h.toFixed(0)}</td>
          <td>
            <div style="display:flex; flex-direction:column; gap:6px; align-items:center">
              <div style="font-weight:900">${pm.toFixed(1)}</div>
              ${badgeHtml(pmLevel)}
            </div>
          </td>
          <td>
            <div style="display:flex; flex-direction:column; gap:6px; align-items:center">
              <div style="font-weight:900">${aqi.toFixed(0)}</div>
              ${badgeHtml(aqiLevel)}
            </div>
          </td>
          <td style="font-weight:900">${uv.toFixed(1)}</td>
          <td style="font-weight:900">${rain}</td>
        </tr>`;
    })
    .join("");
}

async function loadHistory(range = historyRange) {
  try {
    historyRange = range;
    const { from, to, limit } = rangeToQuery(range);

    // order=asc để chart vẽ đúng
    const url = `/api/history?stationId=station1&from=${encodeURIComponent(
      from
    )}&to=${encodeURIComponent(to)}&limit=${limit}&order=asc`;

    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || "history error");

    const rows = json.rows || [];
    historyRowsCache = rows;
    historyPage = 1;

    if (rows.length === 0) {
      const note = $("historyNote");
      if (note) note.innerText = "Chưa có dữ liệu lịch sử. Hãy để ESP chạy vài phút rồi mở lại.";
      initOrUpdateHistoryCharts([], [], [], [], [], []);
      renderHistoryTable();
      return;
    }

    // labels + arrays
    const labels = rows.map((r) => fmtTime(r.createdAt || r.updatedAt || r._id));
    const tempArr = rows.map((r) => safeNum(r.temperature, 0));
    const humArr = rows.map((r) => safeNum(r.humidity, 0));
    const dustArr = rows.map((r) => safeNum(r.dustDensity, 0));
    const aqiArr = rows.map((r) => safeNum(r.co2Level ?? r.aqi ?? 0, 0));
    const rainArr = rows.map((r) => (safeNum(r.rainStatus, 0) === 1 ? 1 : 0));

    // note
    const note = $("historyNote");
    if (note) {
      const last = rows[rows.length - 1];
      const lastTime = new Date(last.createdAt || Date.now()).toLocaleString("vi-VN");
      note.innerText = `Đang hiển thị ${rows.length} mẫu • cập nhật gần nhất: ${lastTime}`;
    }

    initOrUpdateHistoryCharts(labels, tempArr, humArr, dustArr, aqiArr, rainArr);
    renderHistoryTable();
  } catch (e) {
    console.error("History error:", e);
    const note = $("historyNote");
    if (note) note.innerText = "Không tải được lịch sử. Kiểm tra MongoDB (MONGO_URI) và API /api/history.";
    historyRowsCache = [];
    historyPage = 1;
    renderHistoryTable();
  }
}

function bindHistoryRangeChips() {
  const wrap = $("historyRange");
  if (!wrap) return;

  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const range = btn.getAttribute("data-range") || "1d";
      loadHistory(range);
    });
  });
}

function startHistoryPolling() {
  // chỉ poll khi modal đang mở
  stopHistoryPolling();
  loadHistory(historyRange);
  historyTimer = setInterval(() => loadHistory(historyRange), 60000);
}
function stopHistoryPolling() {
  if (historyTimer) {
    clearInterval(historyTimer);
    historyTimer = null;
  }
}

function bindHistoryPager() {
  const prev = $("historyPrev");
  const next = $("historyNext");
  if (prev) {
    prev.addEventListener("click", () => {
      historyPage -= 1;
      renderHistoryTable();
    });
  }
  if (next) {
    next.addEventListener("click", () => {
      historyPage += 1;
      renderHistoryTable();
    });
  }
}

function bindHistoryModalLifecycle() {
  const modal = $("historyModal");
  const close = $("historyClose");
  if (!modal) return;

  // khi mở modal từ HTML sẽ gọi window.__openHistory()
  window.__openHistory = () => {
    // set default chip active theo historyRange
    const wrap = $("historyRange");
    if (wrap) {
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      const btn = wrap.querySelector(`.chip[data-range="${historyRange}"]`);
      if (btn) btn.classList.add("active");
    }
    startHistoryPolling();
  };

  function stopIfClosed() {
    // modal đóng => stop poll
    if (!modal.classList.contains("show")) stopHistoryPolling();
  }

  if (close) close.addEventListener("click", stopIfClosed);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) stopIfClosed();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopIfClosed();
  });

  // theo dõi class changes (trường hợp đóng từ HTML)
  const mo = new MutationObserver(() => stopIfClosed());
  mo.observe(modal, { attributes: true, attributeFilter: ["class"] });
}

// Theme change -> update chart colors (không gọi API lại nặng)
function bindThemeObserver() {
  const sw = $("themeSwitch");
  if (!sw) return;

  sw.addEventListener("click", () => {
    // forecast charts
    if (stationChartRef.current) stationChartRef.current.update();
    if (otherChartRef.current) otherChartRef.current.update();

    // history charts: chỉ update theme, không cần gọi API
    const light = isLightTheme();
    const tickColor = light ? "#0f172a" : "#f8fafc";
    const gridColor = light ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.10)";

    applyChartThemeOptions(historyTHRef.current, tickColor, gridColor);
    applyChartThemeOptions(historyDARRef.current, tickColor, gridColor);
    if (historyTHRef.current) historyTHRef.current.update();
    if (historyDARRef.current) historyDARRef.current.update();
  });
}

// ============== ✅ PUSH / CHUÔNG ==============
async function registerServiceWorkerIfNeeded() {
  if (!("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    return reg;
  } catch (e) {
    console.error("SW register error:", e);
    return null;
  }
}

// Base64 -> Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

async function enableBell() {
  const bellText = $("bellText");
  const btn = $("bellBtn");

  try {
    const reg = await registerServiceWorkerIfNeeded();
    if (!reg) throw new Error("Không đăng ký được Service Worker");

    if (!("Notification" in window)) throw new Error("Trình duyệt không hỗ trợ Notification");

    const perm = await Notification.requestPermission();
    if (perm !== "granted") {
      if (bellText) bellText.innerText = "Chuông (Tắt)";
      return;
    }

    // lấy VAPID public key từ backend
    const vkRes = await fetch("/api/push/vapidPublicKey");
    const vkJson = await vkRes.json();
    if (!vkRes.ok || !vkJson?.publicKey) throw new Error("Thiếu VAPID public key");

    const publicKey = vkJson.publicKey;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });
    }

    // gửi subscription lên backend để lưu
    const saveRes = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ stationId: "station1", subscription: sub }),
    });
    const saveJson = await saveRes.json().catch(() => ({}));
    if (!saveRes.ok || saveJson?.ok === false) {
      throw new Error(saveJson?.error || "Không lưu được subscription");
    }

    if (btn) btn.classList.add("on");
    if (bellText) bellText.innerText = "Chuông (Bật)";
    // demo toast nhỏ
    console.log("✅ Push enabled");
  } catch (e) {
    console.error("Bell enable error:", e);
    if (bellText) bellText.innerText = "Chuông (Lỗi)";
  }
}

function bindBell() {
  const btn = $("bellBtn");
  if (!btn) return;
  btn.addEventListener("click", enableBell);
}

// ============== Init ==============
(function main() {
  // SW: đăng ký sớm (để bấm chuông nhanh)
  registerServiceWorkerIfNeeded();

  // bind history
  bindHistoryRangeChips();
  bindHistoryPager();
  bindHistoryModalLifecycle();

  // theme observer
  bindThemeObserver();

  // bell
  bindBell();

  // dropdown
  if (searchInput && dropdownList) {
    searchInput.addEventListener("focus", () => {
      renderDropdown(locations);
      dropdownList.classList.add("show");
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".search-container")) {
        dropdownList.classList.remove("show");
      }
    });

    searchInput.addEventListener("input", (e) => {
      const val = e.target.value.toLowerCase();
      const filtered = locations.filter((l) => l.name.toLowerCase().includes(val));
      renderDropdown(filtered);
      dropdownList.classList.add("show");
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const val = searchInput.value.trim();
        if (val) {
          dropdownList.classList.remove("show");
          const match = locations.find((l) => l.name.toLowerCase() === val.toLowerCase());
          if (match) {
            selectLocation(match);
          } else {
            if ($("station1Section")) $("station1Section").style.display = "none";
            if ($("otherLocationSection")) $("otherLocationSection").style.display = "block";
            startOtherPolling(val);
          }
        }
      }
    });

    // init default
    searchInput.value = locations[0].name;
    startStationPolling();
  } else {
    // fallback
    startStationPolling();
  }
})();
