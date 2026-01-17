const API_KEY = "a216f02f9004f6fedecea80b73fc8632";

let stationTimer = null;
let otherTimer = null;

const stationChartRef = { current: null };
const otherChartRef = { current: null };

// ============== Helpers ==============
function $(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const el = $(id);
  if (!el) return;
  el.innerText = value;
}

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

/**
 * AQI dạng số 0-500 (giống bạn đang dùng ở trạm 1)
 */
function aqiText(aqi) {
  if (aqi <= 50) return "✅ Tốt";
  if (aqi <= 100) return "⚠️ Trung bình";
  if (aqi <= 150) return "⚠️ Kém";
  return "🚨 Xấu";
}

/**
 * AQI của OpenWeather air_pollution: main.aqi = 1..5
 * 1: Good, 2: Fair, 3: Moderate, 4: Poor, 5: Very Poor
 */
function owmAqiText(aqi1to5) {
  const map = {
    1: "✅ Tốt",
    2: "🟡 Khá",
    3: "⚠️ Trung bình",
    4: "🚨 Kém",
    5: "☠️ Rất xấu",
  };
  return map[aqi1to5] || "—";
}

// ============== Chart ==============
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

// ============== OpenWeather calls ==============
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

async function fetchOwmUvIndex(lat, lon) {
  // UV Index (OpenWeather One Call 3.0) yêu cầu key có quyền One Call.
  // Nếu key của bạn KHÔNG có One Call, request này sẽ fail.
  // Mình xử lý fail an toàn: trả null.
  const url = `https://api.openweathermap.org/data/3.0/onecall?lat=${lat}&lon=${lon}&exclude=minutely,hourly,daily,alerts&appid=${API_KEY}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const uvi = json?.current?.uvi;
    return typeof uvi === "number" ? uvi : null;
  } catch {
    return null;
  }
}

async function fetchOwmAirPollution(lat, lon) {
  const url = `https://api.openweathermap.org/data/2.5/air_pollution?lat=${lat}&lon=${lon}&appid=${API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("air_pollution error");
  return await res.json();
}

/**
 * Update UI for "Other location" UV + AQI + PM
 * - AQI: dùng air_pollution main.aqi (1..5)
 * - PM2.5/PM10: air_pollution components.pm2_5 / pm10
 * - UV: cố lấy từ OneCall UVI (nếu không có quyền thì hiển thị "—")
 */
async function loadOtherAirUv(lat, lon) {
  // AQI + PM
  try {
    const air = await fetchOwmAirPollution(lat, lon);
    const aqi1to5 = air?.list?.[0]?.main?.aqi;
    const comp = air?.list?.[0]?.components || {};
    const pm25 = comp.pm2_5;
    const pm10 = comp.pm10;

    if (typeof aqi1to5 === "number") {
      setText("otherAqiValue", String(aqi1to5)); // hoặc bạn muốn đổi sang thang 0-500 thì nói mình
      setText("otherAqiText", owmAqiText(aqi1to5));
    } else {
      setText("otherAqiValue", "--");
      setText("otherAqiText", "Không có dữ liệu");
    }

    if (typeof pm25 === "number" && typeof pm10 === "number") {
      setText("otherPmText", `PM2.5: ${pm25.toFixed(1)} µg/m³ • PM10: ${pm10.toFixed(1)} µg/m³`);
    } else {
      setText("otherPmText", "PM2.5: -- µg/m³ • PM10: -- µg/m³");
    }
  } catch (e) {
    console.error("air_pollution error:", e);
    setText("otherAqiValue", "--");
    setText("otherAqiText", "Lỗi AQI");
    setText("otherPmText", "PM2.5: -- µg/m³ • PM10: -- µg/m³");
  }

  // UV
  const uvi = await fetchOwmUvIndex(lat, lon);
  if (typeof uvi === "number") {
    setText("otherUvValue", uvi.toFixed(1));
    setText("otherUvText", uvText(uvi));
  } else {
    // key không có OneCall vẫn không crash UI
    setText("otherUvValue", "--");
    setText("otherUvText", "Không có dữ liệu UV");
  }
}

// ============== Station 1 (ESP) ==============
async function loadStation1() {
  try {
    const res = await fetch("/get-sensor");
    if (!res.ok) throw new Error("get-sensor error");
    const data = await res.json();

    loadForecastFor("Da Nang", "forecastGrid", "forecastChart", stationChartRef);

    // ESP status chuẩn: dựa espOnline
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
    const aqi = Number(data.co2Level || 0); // AQI nằm ở co2Level (theo code bạn)
    const uv = Number(data.uvIndex || 0);
    const rain = Number(data.rainStatus || 0);

    setText("sensorTemp", String(Math.round(t)));
    setText("sensorHumidity", String(Math.round(h)));
    setText("sensorDust", dust.toFixed(1));

    // Hiển thị AQI (trạm)
    setText("sensorCO2", String(Math.round(aqi)));
    setText("airQuality", aqiText(aqi));

    // Mưa/khô
    setText("sensorRain", rain === 1 ? "🌧️ MƯA" : "☀️ KHÔ");

    // AQI box
    setText("aqiValue", String(Math.round(aqi)));
    setText("aqiBadge", aqiText(aqi));

    // UV
    setText("uvIndex", uv.toFixed(1));
    setText("uvDesc", uvText(uv));

    // Hero
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

// ============== Other location ==============
async function loadOtherLocation(city) {
  try {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
      city
    )}&units=metric&appid=${API_KEY}&lang=vi`;

    const res = await fetch(url);
    const data = await res.json();

    if (!data || !data.main) {
      console.warn("City not found:", data);
      return;
    }

    setText("otherLocationName", data.name || city);
    setText("otherMainTemp", String(Math.round(data.main.temp)));
    setText("otherMainCondition", data.weather?.[0]?.description || "—");
    setText("otherWeatherIcon", getWeatherIcon(data.weather?.[0]?.main));
    setText("otherHumidity", String(data.main.humidity));
    setText("otherWind", Number(data.wind?.speed || 0).toFixed(1));

    // (Các ô này nằm ngoài section other, nên vẫn cập nhật được)
    if (typeof data.visibility === "number") {
      setText("visibility", (data.visibility / 1000).toFixed(1));
    }
    setText("clouds", String(data.clouds?.all ?? "--"));

    // ✅ NEW: Load UV + AQI/PM theo lat/lon cho địa điểm khác
    const lat = data.coord?.lat;
    const lon = data.coord?.lon;
    if (typeof lat === "number" && typeof lon === "number") {
      await loadOtherAirUv(lat, lon);
    }

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
      '<li class="dropdown-item" style="justify-content:center; color:rgba(255,255,255,0.4)">Không tìm thấy</li>';
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
    const st = $("station1Section");
    const oth = $("otherLocationSection");
    if (st) st.style.display = "block";
    if (oth) oth.style.display = "none";
    startStationPolling();
  } else {
    const st = $("station1Section");
    const oth = $("otherLocationSection");
    if (st) st.style.display = "none";
    if (oth) oth.style.display = "block";
    startOtherPolling(loc.id);
  }
}

// Event Listeners
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
          const st = $("station1Section");
          const oth = $("otherLocationSection");
          if (st) st.style.display = "none";
          if (oth) oth.style.display = "block";
          startOtherPolling(val);
        }
      }
    }
  });

  // Init Default
  searchInput.value = locations[0].name;
  startStationPolling();
} else {
  // Nếu HTML chưa có search input (trường hợp hiếm), vẫn chạy trạm 1
  startStationPolling();
}
