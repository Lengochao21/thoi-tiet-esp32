// ================== AUTO LOAD ==================
loadMyStation();
setInterval(loadMyStation, 30000);

// ================== FETCH BACKEND ==================
async function loadMyStation() {
    try {
        const res = await fetch('/predict-station1');
        const data = await res.json();
        renderUI(data);
    } catch (e) {
        console.error("Frontend error:", e);
    }
}

// ================== RENDER ==================
function renderUI(data) {
    const esp = data.espData;
    const ow = data.openWeatherData;
    const pred = data.predictionToday;

    document.getElementById('locationName').innerText = "TRẠM CỦA TÔI";

    document.getElementById('mainTemp').innerText = esp.temperature + "°C";
    document.getElementById('humidity').innerText = esp.humidity + "%";

    document.getElementById('weatherIcon').innerText =
        getWeatherIcon(ow.weather);

    document.getElementById('mainCondition').innerText =
        pred.recommendation;

    document.getElementById('aqiValue').innerText = esp.co2Level;
    updateAQIStyle(esp.co2Level);

    document.getElementById('confidence').innerText =
        pred.confidence + "%";
}

// ================== UI HELPERS ==================
function getWeatherIcon(w) {
    const icons = {
        Clear: "☀️",
        Clouds: "☁️",
        Rain: "🌧️",
        Thunderstorm: "⛈️"
    };
    return icons[w] || "🌤️";
}

function updateAQIStyle(v) {
    const badge = document.getElementById('aqiBadge');
    badge.className = "aqi-badge " +
        (v < 300 ? "aqi-good" :
        (v < 600 ? "aqi-moderate" : "aqi-bad"));

    badge.innerText =
        v < 300 ? "TỐT" :
        v < 600 ? "TRUNG BÌNH" : "Ô NHIỄM";
}
