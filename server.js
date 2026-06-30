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
    const parts = line
        .split("\t")
        .map(p => p.trim())
        .filter(Boolean);

    if (parts.length < 4) {
        throw new Error("Dong du lieu khong du 4 cot (phone, route, hour, date)");
    }

    const [phone, route, hour, date] = parts;

    return {
        phone,
        route,
        hour,
        date
    };
}





function buildMessage(data) {
    const route = removeVietnameseTones(data.route)
        .replace(/\s+/g, " ")
        .trim()
        .toUpperCase();

    return (
        `Quy Khach Dat Thanh Cong Chuyen Xe ${route} ` +
        `${data.hour} Ngay ${data.date} ` +
        `Quy Khach Luu Lai SDT Tong Dai 19001997 ` +
        `De Tien Dat Xe Cho Chuyen Sau.Tran Trong!`
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
    // chỉ giữ 100 log mới nhất
    logs = logs.slice(-100);
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
        const sendtime = new Date().toISOString();

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
                    requestId: `${Date.now()}_${i}`,
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
                sendtime,
                phone: data.phone,
                message,
                status: code === "000" ? "SUCCESS" : "FAILED",
                errorCode: code,
                errorMessage: ERROR_MAP[code] || ""
            };

            saveLog(logEntry);
            results.push({ line: i + 1, ...logEntry });

        } catch (err) {
            let errorCode = "UNKNOWN";
            let errorMessage = "Unknown error";
            let phone = "";
            let errorType = "";

            // 1️⃣ Lỗi từ API VMG (axios có response)
            if (err.response) {
                const apiData = err.response.data || {};

                errorCode = apiData.errorCode || "API_ERROR";
                errorType = "API_ERROR";

                errorMessage =
                    ERROR_MAP[errorCode] ||
                    apiData.errorMessage ||
                    `API error (HTTP ${err.response.status})`;

                // cố lấy số điện thoại nếu có
                phone = apiData.sendMessage?.to || "";

            }
            // 2️⃣ Lỗi parse / logic (do throw Error)
            else if (err instanceof Error) {
                errorCode = "PARSE_ERROR";
                errorType = "PARSE_ERROR";
                errorMessage = err.message;
            }
            // 3️⃣ Lỗi khác (network, timeout, không xác định)
            else {
                errorCode = "NETWORK_ERROR";
                errorType = "NETWORK_ERROR";
                errorMessage = "Network error or request failed";
            }

            const logEntry = {
                sendtime,
                line: i + 1,
                phone: lines[i],
                status: "FAILED",
                errorType,      // 👈 thêm để phân loại
                errorCode,
                errorMessage
            };

            saveLog(logEntry);
            results.push(logEntry);
        }

        await delay(4000); // delay 4 giây để tránh spam

    }

    res.json({ success: true, results });
});

// =====================
// GET LOGS
// =====================
app.get("/logs", (req, res) => {

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;

    const logs = readLogs().reverse();

    const totalLogs = logs.length;
    const totalPages = Math.ceil(totalLogs / limit);

    const start = (page - 1) * limit;
    const end = start + limit;

    const pageLogs = logs.slice(start, end);

    res.json({
        success: true,
        logs: pageLogs,
        page,
        limit,
        totalLogs,
        totalPages
    });

});

// =====================
// START SERVER
// =====================
app.listen(3000, () => {
    console.log("Backend dang chay tai http://localhost:3000");
});
