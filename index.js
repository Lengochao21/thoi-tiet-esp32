const express = require('express');
const axios = require('axios');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// Dữ liệu mặc định từ cảm biến
let sensorData = { temp: "--", humi: "--" };

// THAY KEY CỦA BẠN VÀO ĐÂY
const API_KEY = 'a216f02f9004f6fedecea80b73fc8632'; 
const CITY = 'Danang'; // Bạn có thể đổi thành Hanoi, HoChiMinh...

// API nhận dữ liệu từ ESP32
app.post('/update-sensor', (req, res) => {
    sensorData = req.body;
    console.log("Dữ liệu mới từ ESP32:", sensorData);
    res.sendStatus(200);
});

// API tổng hợp dữ liệu gửi cho Web
app.get('/api/data', async (req, res) => {
    try {
        const weatherUrl = `https://api.openweathermap.org/data/2.5/forecast?q=${CITY}&appid=${API_KEY}&units=metric&lang=vi`;
        const response = await axios.get(weatherUrl);
        res.json({ 
            local: sensorData, 
            forecast: response.data.list,
            city: response.data.city.name
        });
    } catch (error) {
        res.json({ local: sensorData, forecast: null });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server is running on port ${PORT}`));