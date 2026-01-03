const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// ✅ KHỞI TẠO DỮ LIỆU MẶC ĐỊNH (KHÔNG CÒN "--")
let sensorData = {
    temp: "25",   // giả lập ban đầu
    humi: "60",
    ppm: 120,
    source: "ESP32",
    updatedAt: new Date()
};

// ===== API ESP32 GỬI LÊN =====
app.post('/update-sensor', (req, res) => {
    const { temp, humi, ppm } = req.body;

    // ✅ VALIDATE CƠ BẢN
    if (temp && humi) {
        sensorData = {
            temp: String(temp),
            humi: String(humi),
            ppm: ppm ? Number(ppm) : 0,
            source: "ESP32",
            updatedAt: new Date()
        };

        console.log("📡 Dữ liệu ESP32:", sensorData);
        res.sendStatus(200);
    } else {
        res.status(400).json({ error: "Thiếu dữ liệu cảm biến" });
    }
});

// ===== FRONTEND LẤY =====
app.get('/get-sensor', (req, res) => {
    res.json(sensorData);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 Server AI Live on ${PORT}`)
);
