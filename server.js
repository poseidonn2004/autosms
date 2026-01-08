const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { TOKEN, BRAND } = require("./config");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
// =====================
// CONFIG LOG FILE (CỐ ĐỊNH)
// =====================
const LOG_FILE = path.join(__dirname, "sms-log.json");

// Nếu chưa có file log thì tạo
if (!fs.existsSync(LOG_FILE)) {
    fs.writeFileSync(LOG_FILE, "[]");
}

// =====================
// MAP MÃ LỖI → Ý NGHĨA
// =====================
const ERROR_MAP = {
    "000": "Gui tin thanh cong",
    "011": "Noi dung khong dung mau CSKH da dang ky",
    "019": "So dien thoai khong hop le",
    "904": "Brandname khong hop le hoac chua duoc cap quyen",
    "014": "Tai khoan het so du",
    "100": "Token khong hop le hoac het han",
    "103": "Tai khoan khong co quyen gui CSKH",
    "NETWORK": "Loi mang hoac ket noi API"
};

// =====================
// UTILS
// =====================
function removeVietnameseTones(str) {
    return str
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/đ/g, "d")
        .replace(/Đ/g, "D");
}
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function parseLine(line) {
    const clean = line.trim();

    // 1️⃣ Tìm ngày (dd/mm/yyyy)
    const dateMatch = clean.match(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/);
    if (!dateMatch) {
        throw new Error("Khong tim thay ngay (dd/mm/yyyy)");
    }
    const date = dateMatch[0];

    // 2️⃣ Cắt phần trước ngày
    const beforeDate = clean.slice(0, dateMatch.index).trim();

    // 3️⃣ Tách giờ (số cuối cùng trước ngày)
    const hourMatch = beforeDate.match(/(\d+)\s*$/);
    if (!hourMatch) {
        throw new Error("Khong tim thay gio chay");
    }
    const hour = hourMatch[1];

    // 4️⃣ Phần trước giờ = phone + route
    const beforeHour = beforeDate.slice(0, hourMatch.index).trim();

    // 5️⃣ Phone = số đầu tiên
    const phoneMatch = beforeHour.match(/^\d{9,11}/);
    if (!phoneMatch) {
        throw new Error("Khong tim thay so dien thoai");
    }
    const phone = phoneMatch[0];

    // 6️⃣ Route = tất cả phần còn lại (GIỮ NGUYÊN DẤU CÁCH)
    const route = beforeHour.slice(phone.length).trim();

    return {
        phone,
        route,
        hour,
        date
    };
}




function buildMessage(data) {
    const route = removeVietnameseTones(data.route)
        .replace(/\s+/g, " ")   // 2–3 dấu cách → 1 dấu
        .trim()
        .toUpperCase();

    return (
        `Quy Khach Dat Thanh Cong Chuyen Xe ${route} ` +
        `${data.hour}h Ngay ${data.date} ` +
        `Quy Khach Luu Lai SDT Tong Dai 19001997 ` +
        `De Tien Dat Xe Cho Chuyen Sau. Tran Trong!`
    );
}


function normalizePhone(phone) {
    return phone.startsWith("0") ? "84" + phone.slice(1) : phone;
}

// =====================
// LOG FUNCTIONS
// =====================
function saveLog(entry) {
    let logs = [];

    if (fs.existsSync(LOG_FILE)) {
        logs = JSON.parse(fs.readFileSync(LOG_FILE, "utf8") || "[]");
    }

    logs.push(entry);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function readLogs() {
    if (!fs.existsSync(LOG_FILE)) return [];
    return JSON.parse(fs.readFileSync(LOG_FILE, "utf8") || "[]");
}

// =====================
// PREVIEW
// =====================
app.post("/preview", (req, res) => {
    try {
        const lines = req.body.input.split("\n").filter(l => l.trim());
        const preview = lines.map((line, i) => {
            const data = parseLine(line);
            return {
                index: i + 1,
                phone: normalizePhone(data.phone),
                message: buildMessage(data)
            };
        });

        res.json({ success: true, preview });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// =====================
// SEND BULK SMS
// =====================
app.post("/send-bulk", async (req, res) => {
    const lines = req.body.input.split("\n").filter(l => l.trim());
    const results = [];

    for (let i = 0; i < lines.length; i++) {
        const time = new Date().toISOString();

        try {
            const data = parseLine(lines[i]);
            const message = buildMessage(data);

            const r = await axios.post(
                "https://api.brandsms.vn/api/SMSBrandname/SendSMS",
                {
                    to: normalizePhone(data.phone),
                    from: BRAND,
                    message,
                    scheduled: "",
                    requestId: "",
                    useUnicode: 0,
                    type: 1
                },
                {
                    headers: {
                        "Content-Type": "application/json",
                        token: TOKEN
                    }
                }
            );

            const code = r.data.errorCode;

            const logEntry = {
                time,
                phone: data.phone,
                message,
                status: code === "000" ? "SUCCESS" : "FAILED",
                errorCode: code,
                errorMessage: ERROR_MAP[code] || ""
            };

            saveLog(logEntry);
            results.push({ line: i + 1, ...logEntry });

        } catch (err) {
            const errorData = err.response?.data || {};
            const code = errorData.errorCode || "NETWORK";

            const logEntry = {
                time,
                phone: lines[i],
                message: "",
                status: "FAILED",
                errorCode: code,
                errorMessage: ERROR_MAP[code] || err.message
            };

            saveLog(logEntry);
            results.push({ line: i + 1, ...logEntry });
        }
        await delay(3000); // delay 3 giây để tránh spam

    }

    res.json({ success: true, results });
});

// =====================
// GET LOGS
// =====================
app.get("/logs", (req, res) => {
    const logs = readLogs().reverse();
    res.json({ success: true, logs });
});

// =====================
// START SERVER
// =====================
app.listen(3000, () => {
    console.log("Backend dang chay tai http://localhost:3000");
});
