const API_KEY = "a216f02f9004f6fedecea80b73fc8632"; // Key của Hào

// Tìm kiếm thành phố bất kỳ
async function searchCity() {
    const city = document.getElementById('cityInput').value;
    if (!city) return;
    fetchWeather(city);
}

// Lấy lại dữ liệu từ trạm thực tế của bạn
async function loadMyStation() {
    try {
        const res = await fetch('/get-sensor');
        const data = await res.json();
        
        // Hiển thị dữ liệu thực
        document.getElementById('cityName').innerHTML = '<i class="fa-solid fa-house-signal"></i> TRẠM CỦA TÔI';
        document.getElementById('tempMain').innerText = data.temp || "--";
        document.getElementById('humiVal').innerText = (data.humi || "--") + "%";
        document.getElementById('aqiVal').innerText = data.ppm || "0";
        updateAQI(data.ppm);
        
        // Lấy bù thông tin gió/uv từ API cho vị trí trạm (Da Nang)
        fetchExternalDataOnly("Da Nang");
    } catch (e) { console.error("Lỗi trạm"); }
}

async function fetchWeather(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}&lang=vi`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        document.getElementById('cityName').innerHTML = `<i class="fa-solid fa-location-dot"></i> ${data.name}`;
        document.getElementById('tempMain').innerText = Math.round(data.main.temp);
        document.getElementById('humiVal').innerText = data.main.humidity + "%";
        document.getElementById('windVal').innerText = data.wind.speed + " m/s";
        document.getElementById('weatherDesc').innerText = data.weather[0].description;
        
        // AQI giả lập từ mây
        let aqi = Math.floor(data.clouds.all * 1.5 + 10);
        document.getElementById('aqiVal').innerText = aqi;
        updateAQI(aqi);
        document.getElementById('uvVal').innerText = (Math.random() * 3 + 1).toFixed(1);
    } catch (e) { alert("Không tìm thấy thành phố!"); }
}

async function fetchExternalDataOnly(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    document.getElementById('windVal').innerText = data.wind.speed + " m/s";
    document.getElementById('uvVal').innerText = "1.0";
    document.getElementById('weatherDesc').innerText = data.weather[0].description;
}

function updateAQI(val) {
    const badge = document.getElementById('aqiStatus');
    if (val < 50) { badge.innerText = "TỐT"; badge.style.background = "#10b981"; badge.style.color = "white"; }
    else if (val < 150) { badge.innerText = "TRUNG BÌNH"; badge.style.background = "#f59e0b"; badge.style.color = "black"; }
    else { badge.innerText = "Ô NHIỄM"; badge.style.background = "#ef4444"; badge.style.color = "white"; }
}

// Mặc định load trạm khi mở trang
loadMyStation();