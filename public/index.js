// Cập nhật mã API Key từ ảnh image_c55b57.png của Hào
const API_KEY = "a216f02f9004f6fedecea80b73fc8632"; 

async function handleLocationChange() {
    const mode = document.getElementById('locationSelect').value;
    
    if (mode === "my_station") {
        fetchFromMyStation();
    } else {
        fetchFromOpenWeather(mode);
    }
}

// Lấy dữ liệu thực tế từ ESP32 thông qua Backend
async function fetchFromMyStation() {
    try {
        const response = await fetch('/get-sensor');
        const data = await response.json();
        
        // Hiển thị lên các thẻ HTML tương ứng
        document.getElementById('temp').innerText = data.temp || "--";
        document.getElementById('humi').innerText = data.humi || "--";
        document.getElementById('aqi').innerText = data.ppm || "0";
        
        // Cập nhật màu sắc AQI
        updateAQIStatus(data.ppm);
        
        // Lấy bù dữ liệu gió và UV cho vị trí trạm từ OpenWeatherMap
        fetchBackupWeatherData("Da Nang"); 
    } catch (error) {
        console.error("Lỗi khi kết nối với Server Backend:", error);
    }
}

// Lấy dữ liệu thời tiết cho các thành phố khác qua API
async function fetchFromOpenWeather(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}&lang=vi`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        document.getElementById('temp').innerText = Math.round(data.main.temp);
        document.getElementById('humi').innerText = data.main.humidity;
        document.getElementById('wind').innerText = data.wind.speed;
        document.getElementById('rainStatus').innerText = data.weather[0].description.toUpperCase();
        
        // Giả lập chỉ số AQI dựa trên mây
        let mockAQI = Math.floor(data.clouds.all * 1.2 + 10);
        document.getElementById('aqi').innerText = mockAQI;
        updateAQIStatus(mockAQI);
        
        // Giả lập UV
        document.getElementById('uv').innerText = (Math.random() * 6 + 1).toFixed(1);
    } catch (e) {
        console.error("Lỗi API OpenWeatherMap!");
    }
}

// Hàm phụ để lấy Gió/UV cho trạm đo
async function fetchBackupWeatherData(city) {
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${city}&units=metric&appid=${API_KEY}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        document.getElementById('wind').innerText = data.wind.speed;
        document.getElementById('uv').innerText = "4.5"; // Mặc định cho trạm
        document.getElementById('rainStatus').innerText = data.weather[0].description.toUpperCase();
    } catch (e) {}
}

// Cập nhật trạng thái màu sắc AQI
function updateAQIStatus(val) {
    const status = document.getElementById('aqiStatus');
    if (val < 50) {
        status.innerText = "CHẤT LƯỢNG: TỐT";
        status.style.background = "#10b981";
    } else if (val < 150) {
        status.innerText = "CHẤT LƯỢNG: TRUNG BÌNH";
        status.style.background = "#f59e0b";
    } else {
        status.innerText = "CHẤT LƯỢNG: Ô NHIỄM";
        status.style.background = "#ef4444";
    }
}

// Khởi chạy
handleLocationChange();
// Tự động làm mới mỗi 20 giây
setInterval(handleLocationChange, 20000);