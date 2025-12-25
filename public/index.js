const API_KEY = "a216f02f9004f6fedecea80b73fc8632"; // Key của Hào

let multiSourceData = {
    myStation: null,
    danang: null,
    hanoi: null,
    hcm: null
};

// Hàm tìm kiếm tùy chỉnh
function searchCustom() {
    const input = document.getElementById('customSearch').value.trim();
    if (input) {
        loadWeatherData(input);
    }
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

// Lấy dữ liệu đa nguồn từ Server và OpenWeather
async function fetchMultiSourceData() {
    const promises = [
        fetch('/get-sensor').then(r => r.json()).catch(() => null),
        fetchOpenWeatherData('Da Nang'),
        fetchOpenWeatherData('Hanoi'),
        fetchOpenWeatherData('Ho Chi Minh')
    ];
    
    const [station, danang, hanoi, hcm] = await Promise.all(promises);
    multiSourceData = { myStation: station, danang, hanoi, hcm };
    return multiSourceData;
}

// Logic AI dự báo dựa trên trạm của Hào
async function fetchMyStationWithAI() {
    await fetchMultiSourceData();
    const myData = multiSourceData.myStation;
    
    if (!myData || myData.temp === "--") {
        await fetchCityWeather('Da Nang');
        return;
    }
    
    document.getElementById('locationName').innerText = 'Trạm Của Tôi';
    document.getElementById('mainTemp').innerText = myData.temp;
    document.getElementById('feelsLike').innerText = myData.temp;
    document.getElementById('humidity').innerText = myData.humi;
    document.getElementById('aqiValue').innerText = myData.ppm;
    updateAQIStyle(myData.ppm);
    
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
    
    // Thuật toán AI của bạn
    const forecast = predictWeatherWithAI(myData, multiSourceData);
    document.getElementById('mainCondition').innerText = forecast;
}

// Các hàm tính toán giữ nguyên theo code bạn gửi
function predictWeatherWithAI(myStation, sources) {
    const myHumi = parseFloat(myStation.humi);
    if (myHumi > 85) return "SẮP MƯA TO";
    if (myHumi > 75) return "MƯA RÀO KHẢ NĂNG CAO";
    return sources.danang ? sources.danang.weather[0].description.toUpperCase() : "THỜI TIẾT ỔN ĐỊNH";
}

async function fetchOpenWeatherData(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}&lang=vi`;
    try {
        const res = await fetch(url);
        return await res.json();
    } catch (e) { return null; }
}

async function fetchCityWeather(city) {
    const data = await fetchOpenWeatherData(city);
    if (!data || data.cod === "404") return;
    
    document.getElementById('locationName').innerText = data.name;
    document.getElementById('mainTemp').innerText = Math.round(data.main.temp);
    document.getElementById('humidity').innerText = data.main.humidity;
    document.getElementById('windSpeed').innerText = data.wind.speed.toFixed(1);
    document.getElementById('mainCondition').innerText = data.weather[0].description.toUpperCase();
    document.getElementById('weatherIcon').innerText = getWeatherIcon(data.weather[0].main);
    
    let estimatedAqi = Math.floor(data.clouds.all * 1.5);
    document.getElementById('aqiValue').innerText = estimatedAqi;
    updateAQIStyle(estimatedAqi);
}

function getWeatherIcon(weather) {
    const icons = { 'Clear': '☀️', 'Clouds': '☁️', 'Rain': '🌧️', 'Thunderstorm': '⛈️', 'Mist': '🌫️' };
    return icons[weather] || '🌤️';
}

function calculateUV(data) {
    let uv = 11 - (data.clouds.all / 10);
    return Math.max(0, Math.min(11, uv)).toFixed(1);
}

function updateUVDesc(uv) {
    const val = parseFloat(uv);
    let desc = val < 3 ? 'Thấp - An toàn' : (val < 6 ? 'Trung bình' : 'Cao');
    document.getElementById('uvDesc').innerText = desc;
}

function updateAQIStyle(val) {
    const badge = document.getElementById('aqiBadge');
    if (val < 50) { badge.innerText = 'TỐT'; badge.className = 'aqi-badge aqi-good'; }
    else if (val < 150) { badge.innerText = 'TRUNG BÌNH'; badge.className = 'aqi-badge aqi-moderate'; }
    else { badge.innerText = 'Ô NHIỄM'; badge.className = 'aqi-badge aqi-bad'; }
}

function formatTime(timestamp) {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

// Chạy mặc định
handleLocationChange();
setInterval(handleLocationChange, 30000);