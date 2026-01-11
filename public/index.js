// ================== CONFIG ==================
const REFRESH_INTERVAL = 30000;

// ================== AUTO LOAD ==================
loadMyStation();
setInterval(loadMyStation, REFRESH_INTERVAL);

// ================== FETCH BACKEND ==================
async function loadMyStation() {
    try {
        const res = await fetch('/get-sensor');
        if (!res.ok) throw new Error("API error");

        const data = await res.json();
        renderMyStation(data);

    } catch (e) {
        console.error("Frontend error:", e);
        showError();
    }
}

// ================== RENDER MAIN ==================
function renderMyStation(data) {
    document.getElementById('locationName').innerText = "TRẠM CỦA TÔI";

    // ---- Temperature ----
    document.getElementById('mainTemp').innerText =
        data.temperature !== undefined
            ? data.temperature.toFixed(1) + "°C"
            : "--";

    // ---- Humidity ----
    document.getElementById('humidity').innerText =
        data.humidity !== undefined
            ? data.humidity.toFixed(0) + "%"
            : "--";

    // ---- AQI / CO2 ----
    const aqi = data.co2Level ?? 0;
    document.getElementById('aqiValue').innerText = aqi;
    updateAQIStyle(aqi);

    // ---- Weather condition (ESP station) ----
    document.getElementById('mainCondition').innerText =
        buildStationCondition(data);

    // ---- Icon (giả lập theo nhiệt độ + độ ẩm) ----
    document.getElementById('weatherIcon').innerText =
        getStationIcon(data);

    // ---- Last update ----
    if (data.lastUpdate) {
        const t = new Date(data.lastUpdate);
        document.getElementById('lastUpdate').innerText =
            t.toLocaleTimeString('vi-VN');
    }
}

// ================== LOGIC PHÂN TÍCH ==================
function buildStationCondition(d) {
    if (d.temperature > 32 && d.humidity > 75)
        return "NÓNG ẨM – DỄ MƯA DÔNG";

    if (d.temperature > 35)
        return "NẮNG NÓNG GAY GẮT";

    if (d.humidity > 85)
        return "ẨM CAO – CÓ KHẢ NĂNG MƯA";

    return "THỜI TIẾT ỔN ĐỊNH";
}

function getStationIcon(d) {
    if (d.humidity > 85) return "🌧️";
    if (d.temperature > 34) return "☀️";
    if (d.temperature < 20) return "🌥️";
    return "⛅";
}

// ================== UI HELPERS ==================
function updateAQIStyle(v) {
    const badge = document.getElementById('aqiBadge');

    badge.className = "aqi-badge " +
        (v < 300 ? "aqi-good" :
        (v < 600 ? "aqi-moderate" : "aqi-bad"));

    badge.innerText =
        v < 300 ? "TỐT" :
        v < 600 ? "TRUNG BÌNH" : "Ô NHIỄM";
}

function showError() {
    document.getElementById('mainCondition').innerText =
        "KHÔNG KẾT NỐI ĐƯỢC TRẠM";
}
