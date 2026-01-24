// /public/index.js
// NOTE:
// - File này giữ nguyên các phần  đang có (forecast, station realtime, other city).
// - chỉ THÊM phần "LỊCH SỬ" (gọi /api/history) + 2 chart (Temp+Hum) và (Dust + Rain)
// - Và cho chart/tooltip tự đổi màu theo theme (dark/light) dựa trên body[data-theme].

const API_KEY = "a216f02f9004f6fedecea80b73fc8632";

let stationTimer = null;
let otherTimer = null;

const stationChartRef = { current: null };
const otherChartRef = { current: null };

// ✅ history chart refs
const historyTHRef = { current: null }; // Temp + Hum
const historyDRRef = { current: null }; // Dust + Rain
let historyRange = "1h"; // default
let historyTimer = null;

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
  if (aqi <= 100) return "⚠️ Trung bình";
  if (aqi <= 150) return "⚠️ Kém";
  return "🚨 Xấu";
}

// ============== Chart base (forecast) ==============
function initOrUpdateChart(canvasId, chartRef, labels, data) {
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
            pointRadius: 4,
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
              label: (context) => context.parsed.y.toFixed(1) + "°C",
            },
          },
        },
        scales: {
          y: {
            grid: { color: gridColor },
            ticks: { color: tickColor },
          },
          x: {
            grid: { color: gridColor },
            ticks: { color: tickColor },
          },
        },
      },
    });
  } else {
    chartRef.current.data.labels = labels;
    chartRef.current.data.datasets[0].data = data;
    // update theme colors if changed
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

  initOrUpdateChart(chartCanvasId, chartRef, chartLabels, chartData);
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

    const t = Number(data.temperature || 0);
    const h = Number(data.humidity || 0);
    const dust = Number(data.dustDensity || 0);
    const aqi = Number(data.co2Level || 0); // AQI của ESP nằm ở co2Level
    const uv = Number(data.uvIndex || 0);
    const rain = Number(data.rainStatus || 0);

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

// ============== ✅ HISTORY ==============
function rangeToQuery(range) {
  // server supports: /api/history?stationId=station1&from=...&to=...&limit=...
  const now = Date.now();
  let fromMs = now - 60 * 60 * 1000; // default 1h
  if (range === "6h") fromMs = now - 6 * 60 * 60 * 1000;
  else if (range === "24h") fromMs = now - 24 * 60 * 60 * 1000;
  else if (range === "7d") fromMs = now - 7 * 24 * 60 * 60 * 1000;

  // ISO date string
  const from = new Date(fromMs).toISOString();
  const to = new Date(now).toISOString();

  // limit: 1 phút/lần => 1h~60, 6h~360, 24h~1440, 7d~10080
  // clamp để không quá nặng
  let limit = 200;
  if (range === "1h") limit = 120;
  if (range === "6h") limit = 500;
  if (range === "24h") limit = 1200;
  if (range === "7d") limit = 2000;
  limit = clamp(limit, 50, 2000);

  return { from, to, limit };
}

function buildTimeLabel(iso) {
  const d = new Date(iso);
  // gọn: HH:mm hoặc dd/MM HH:mm nếu range dài
  const hhmm = d.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
  const ddmm = d.toLocaleDateString("vi-VN", { day: "2-digit", month: "2-digit" });
  if (historyRange === "7d") return `${ddmm} ${hhmm}`;
  if (historyRange === "24h") return `${hhmm}`;
  return `${hhmm}`;
}

function initOrUpdateHistoryCharts(labels, tempArr, humArr, dustArr, rainArr) {
  const light = isLightTheme();
  const tickColor = light ? "#0f172a" : "#f8fafc";
  const gridColor = light ? "rgba(15,23,42,0.10)" : "rgba(255,255,255,0.10)";

  // ---- Chart 1: Temp + Hum (2 lines)
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

      historyTHRef.current.options.plugins.legend.labels.color = tickColor;
      historyTHRef.current.options.scales.x.ticks.color = tickColor;
      historyTHRef.current.options.scales.y.ticks.color = tickColor;
      historyTHRef.current.options.scales.y1.ticks.color = tickColor;
      historyTHRef.current.options.scales.x.grid.color = gridColor;
      historyTHRef.current.options.scales.y.grid.color = gridColor;
      historyTHRef.current.update();
    }
  }

  // ---- Chart 2: Dust line + Rain bar 0/1
  const c2 = $("historyDustRainChart");
  if (c2) {
    const ctx2 = c2.getContext("2d");
    if (!historyDRRef.current) {
      historyDRRef.current = new Chart(ctx2, {
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
              yAxisID: "y",
            },
            {
              type: "bar",
              label: "Mưa (0/1)",
              data: rainArr,
              backgroundColor: "rgba(16,185,129,0.35)",
              borderColor: "rgba(16,185,129,0.55)",
              borderWidth: 1,
              yAxisID: "y1",
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
                  if (ctx.dataset.type === "bar") {
                    return `Mưa: ${ctx.parsed.y === 1 ? "Có" : "Không"}`;
                  }
                  return `${ctx.dataset.label}: ${Number(ctx.parsed.y).toFixed(1)}`;
                },
              },
            },
          },
          scales: {
            x: { grid: { color: gridColor }, ticks: { color: tickColor, maxTicksLimit: 8 } },
            y: {
              grid: { color: gridColor },
              ticks: { color: tickColor },
              title: { display: true, text: "PM2.5", color: tickColor },
            },
            y1: {
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
      historyDRRef.current.data.labels = labels;
      historyDRRef.current.data.datasets[0].data = dustArr;
      historyDRRef.current.data.datasets[1].data = rainArr;

      historyDRRef.current.options.plugins.legend.labels.color = tickColor;
      historyDRRef.current.options.scales.x.ticks.color = tickColor;
      historyDRRef.current.options.scales.y.ticks.color = tickColor;
      historyDRRef.current.options.scales.y1.ticks.color = tickColor;
      historyDRRef.current.options.scales.x.grid.color = gridColor;
      historyDRRef.current.options.scales.y.grid.color = gridColor;
      historyDRRef.current.update();
    }
  }
}

async function loadHistory(range = historyRange) {
  try {
    if (!$("historyBlock")) return; // nếu bạn xoá khối lịch sử thì bỏ qua

    historyRange = range;
    const { from, to, limit } = rangeToQuery(range);

    const url = `/api/history?stationId=station1&from=${encodeURIComponent(
      from
    )}&to=${encodeURIComponent(to)}&limit=${limit}`;

    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || "history error");

    const rows = json.rows || [];
    if (rows.length === 0) {
      const note = $("historyNote");
      if (note) note.innerText = "Chưa có dữ liệu lịch sử (MongoDB). Hãy để ESP chạy và chờ 1-2 phút.";
      // clear charts
      initOrUpdateHistoryCharts([], [], [], [], []);
      return;
    }

    const labels = rows.map((r) => buildTimeLabel(r.createdAt || r.updatedAt || r._id));
    const tempArr = rows.map((r) => Number(r.temperature ?? 0));
    const humArr = rows.map((r) => Number(r.humidity ?? 0));
    const dustArr = rows.map((r) => Number(r.dustDensity ?? 0));
    const rainArr = rows.map((r) => (Number(r.rainStatus ?? 0) === 1 ? 1 : 0));

    // update note
    const note = $("historyNote");
    if (note) {
      const last = rows[rows.length - 1];
      const lastTime = new Date(last.createdAt).toLocaleString("vi-VN");
      note.innerText = `Đang hiển thị ${rows.length} mẫu • cập nhật gần nhất: ${lastTime}`;
    }

    initOrUpdateHistoryCharts(labels, tempArr, humArr, dustArr, rainArr);
  } catch (e) {
    console.error("History error:", e);
    const note = $("historyNote");
    if (note) note.innerText = "Không tải được lịch sử. Kiểm tra MongoDB (MONGO_URI) và API /api/history.";
  }
}

function bindHistoryRangeChips() {
  const wrap = $("historyRange");
  if (!wrap) return;

  wrap.querySelectorAll(".chip").forEach((btn) => {
    btn.addEventListener("click", () => {
      wrap.querySelectorAll(".chip").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      const range = btn.getAttribute("data-range") || "1h";
      loadHistory(range);
    });
  });
}

function startHistoryPolling() {
  if (!$("historyBlock")) return;
  // load now
  loadHistory(historyRange);
  // refresh every 60s
  if (!historyTimer) historyTimer = setInterval(() => loadHistory(historyRange), 60000);
}
function stopHistoryPolling() {
  if (historyTimer) {
    clearInterval(historyTimer);
    historyTimer = null;
  }
}

// Khi theme đổi -> refresh chart colors (không gọi API lại)
function bindThemeObserver() {
  const sw = $("themeSwitch");
  if (!sw) return;

  sw.addEventListener("click", () => {
    // sau khi theme đổi, update chart theme colors:
    // forecast charts
    if (stationChartRef.current) stationChartRef.current.update();
    if (otherChartRef.current) otherChartRef.current.update();
    // history charts: gọi lại init update với data hiện tại
    if (historyTHRef.current || historyDRRef.current) {
      // gọi nhẹ loadHistory để update colors + labels (server cached/nhanh)
      loadHistory(historyRange);
    }
  });
}

// ============== Polling ==============
function startStationPolling() {
  stopOtherPolling();
  loadStation1();
  if (!stationTimer) stationTimer = setInterval(loadStation1, 10000);

  // ✅ lịch sử chỉ hợp lý khi đang ở trạm 1
  startHistoryPolling();
}

function stopStationPolling() {
  if (stationTimer) {
    clearInterval(stationTimer);
    stationTimer = null;
  }
  stopHistoryPolling();
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

  // ✅ bind history chips + theme observer
  bindHistoryRangeChips();
  bindThemeObserver();

  // Init default
  searchInput.value = locations[0].name;
  startStationPolling();
} else {
  // fallback
  bindHistoryRangeChips();
  bindThemeObserver();
  startStationPolling();
}
