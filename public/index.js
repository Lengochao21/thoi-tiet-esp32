const API_KEY = "a216f02f9004f6fedecea80b73fc8632"; // Key OPEN WEATHER CỦA TOI 

let multiSourceData = { myStation: null, danang: null, hanoi: null, hcm: null };

function searchCustom() {
    const input = document.getElementById('customSearch').value.trim();
    if (input) loadWeatherData(input);
}

async function handleLocationChange() {
    const mode = document.getElementById('locationSelect').value;
    await loadWeatherData(mode);
}

async function loadWeatherData(location) {
    if (location === 'my_station') {
        document.getElementById('aiIndicator').style.display = 'inline-flex';
        await fetchMyStationWithAI();
    } else {
        document.getElementById('aiIndicator').style.display = 'none';
        await fetchCityWeather(location);
    }
}

async function fetchMultiSourceData() {
    const promises = [
        fetch('/get-sensor').then(r => r.json()).catch(() => null), // Gọi về server Render
        fetchOpenWeatherData('Da Nang'),
        fetchOpenWeatherData('Hanoi'),
        fetchOpenWeatherData('Ho Chi Minh')
    ];
    const [station, danang, hanoi, hcm] = await Promise.all(promises);
    multiSourceData = { myStation: station, danang, hanoi, hcm };
    return multiSourceData;
}

async function fetchOpenWeatherData(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}&lang=vi`;
    try {
        const res = await fetch(url);
        return await res.json();
    } catch (e) { return null; }
}

async function fetchMyStationWithAI() {
    await fetchMultiSourceData();
    const myData = multiSourceData.myStation;
    if (!myData || myData.temp === "--") {
        await fetchCityWeather('Da Nang');
        return;
    }
    document.getElementById('locationName').innerText = 'Trạm Của Tôi';
    document.getElementById('mainTemp').innerText = myData.temp;
    document.getElementById('humidity').innerText = myData.humi;
    document.getElementById('aqiValue').innerText = myData.ppm || 0;
    updateAQIStyle(myData.ppm || 0);
    
    if (multiSourceData.danang) {
        const data = multiSourceData.danang;
        document.getElementById('windSpeed').innerText = data.wind.speed.toFixed(1);
        document.getElementById('pressure').innerText = data.main.pressure;
        document.getElementById('visibility').innerText = (data.visibility / 1000).toFixed(1);
        document.getElementById('clouds').innerText = data.clouds.all;
        document.getElementById('sunrise').innerText = formatTime(data.sys.sunrise);
        document.getElementById('sunset').innerText = formatTime(data.sys.sunset);
        document.getElementById('uvIndex').innerText = calculateUV(data);
        updateUVDesc(calculateUV(data));
        document.getElementById('weatherIcon').innerText = getWeatherIcon(data.weather[0].main);
    }
    document.getElementById('mainCondition').innerText = predictWeatherWithAI(myData, multiSourceData);
}

// Giữ nguyên các hàm hỗ trợ formatTime, calculateUV, predictWeatherWithAI... của Hào
function formatTime(t) { return new Date(t * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' }); }
function getWeatherIcon(w) { const i = { 'Clear':'☀️','Clouds':'☁️','Rain':'🌧️','Thunderstorm':'⛈️'}; return i[w] || '🌤️'; }
function calculateUV(d) { let uv = 11 - (d.clouds.all / 10); return Math.max(0, Math.min(11, uv)).toFixed(1); }
function updateUVDesc(uv) { const v = parseFloat(uv); document.getElementById('uvDesc').innerText = v<3?'Thấp':(v<6?'Trung bình':'Cao'); }
function updateAQIStyle(v) { const b = document.getElementById('aqiBadge'); b.className = 'aqi-badge ' + (v<50?'aqi-good':(v<150?'aqi-moderate':'aqi-bad')); b.innerText = v<50?'TỐT':(v<150?'TRUNG BÌNH':'Ô NHIỄM'); }
function predictWeatherWithAI(s, src) { if (parseFloat(s.humi) > 85) return "SẮP MƯA TO"; return src.danang ? src.danang.weather[0].description.toUpperCase() : "ỔN ĐỊNH"; }

handleLocationChange();
setInterval(handleLocationChange, 30000);