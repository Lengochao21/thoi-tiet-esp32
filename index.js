const express = require('express');
const cors = require('cors'); 
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let sensorData = {
    temp: "--",
    humi: "--",
    ppm: 0,
    lastUpdate: 0
};

app.post('/update-sensor', (req, res) => {
    sensorData = {
        ...req.body,
        lastUpdate: Date.now()
    };
    console.log("📡 ESP32 gửi:", sensorData);
    res.sendStatus(200);
});

app.get('/get-sensor', (req, res) => {
    res.json(sensorData);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 Server chạy tại cổng ${PORT}`)
);
