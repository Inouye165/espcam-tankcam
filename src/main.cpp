#include <WiFi.h>
#include <WiFiUdp.h>
#include "esp_http_server.h"

#ifndef DEVICE_NAME
#define DEVICE_NAME "esp32cam"
#endif

// Dynamically configuration based on board type
#if defined(ARDUINO_XIAO_ESP32S3)
// Seeed Studio XIAO ESP32S3 Sense Pin Definitions
#include "esp_camera.h"
#define BOARD_NAME "XIAO_ESP32S3"
#define PWDN_GPIO_NUM     -1
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM     10
#define SIOD_GPIO_NUM     40
#define SIOC_GPIO_NUM     39
#define Y9_GPIO_NUM       48
#define Y8_GPIO_NUM       11
#define Y7_GPIO_NUM       12
#define Y6_GPIO_NUM       14
#define Y5_GPIO_NUM       16
#define Y4_GPIO_NUM       18
#define Y3_GPIO_NUM       17
#define Y2_GPIO_NUM       15
#define VSYNC_GPIO_NUM    38
#define HREF_GPIO_NUM     47
#define PCLK_GPIO_NUM     13
#define FLASH_GPIO_NUM    21 // User LED (Active LOW)
#define FLASH_ACTIVE_LOW  true

#elif defined(ARDUINO_XIAO_ESP32C3)
// Seeed Studio XIAO ESP32C3 has no built-in camera port or PSRAM.
// We use a mock MJPEG stream for testing WiFi and discovery.
#define BOARD_NAME "XIAO_ESP32C3"
#define MOCK_CAMERA       1
#define FLASH_GPIO_NUM    -1
#define FLASH_ACTIVE_LOW  false

#elif defined(BOARD_WAVESHARE_ESP32)
// Waveshare ESP32 General Driver Board
#define BOARD_NAME "WAVESHARE_ESP32"
#define MOCK_CAMERA       1
#define FLASH_GPIO_NUM    -1
#define FLASH_ACTIVE_LOW  false
#include <Wire.h>
#include <Adafruit_INA219.h>
#include <QMI8658.h>
extern Adafruit_INA219 ina219;
extern bool ina219_initialized;
extern QMI8658 imu;
extern bool imu_initialized;


#else
// Default AI-Thinker Camera Pin Definitions (esp32cam)
#include "esp_camera.h"
#define BOARD_NAME "ESP32CAM"
#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22
#define FLASH_GPIO_NUM     4
#define FLASH_ACTIVE_LOW  false
#endif

#ifdef MOCK_CAMERA
// 102-byte minimal valid JPEG image
const uint8_t mock_jpg[] = {
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48, 
  0x00, 0x48, 0x00, 0x00, 0xFF, 0xDB, 0x00, 0x43, 0x00, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 
  0xC2, 0x00, 0x0B, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xFF, 0xC4, 0x00, 0x14, 
  0x10, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 
  0x00, 0x00, 0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x01, 0x3F, 0x10, 0xFF, 0xD9
};
const size_t mock_jpg_len = sizeof(mock_jpg);
#endif


// Wi-Fi details
const char* ssid1 = "Pumpkinpie";
const char* pass1 = "dobbyaspenindy";
const char* ssid2 = "Dobby";
const char* pass2 = "sanmina-1";

// UDP details for broadcast discovery
WiFiUDP udp;
const int udpPort = 3000;
unsigned long lastBeaconTime = 0;
#ifdef BOARD_WAVESHARE_ESP32
const unsigned long beaconInterval = 50; // 50ms (20 Hz) for real-time tracking
#else
const unsigned long beaconInterval = 2000; // 2 seconds
#endif


httpd_handle_t stream_httpd = NULL;

#ifdef BOARD_WAVESHARE_ESP32
Adafruit_INA219 ina219(0x42);
bool ina219_initialized = false;
QMI8658 imu;
bool imu_initialized = false;

// AK09918 Magnetometer
bool ak09918_initialized = false;

bool writeAKRegister(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(0x0C);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

bool readAKRegisters(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(0x0C);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  
  uint8_t rx = Wire.requestFrom((uint8_t)0x0C, len);
  if (rx != len) return false;
  for (uint8_t i = 0; i < len; i++) {
    buf[i] = Wire.read();
  }
  return true;
}

bool initAK09918() {
  uint8_t wia2 = 0;
  if (!readAKRegisters(0x01, &wia2, 1) || wia2 != 0x0C) {
    Serial.println("AK09918 magnetometer not found at I2C address 0x0C.");
    return false;
  }
  if (!writeAKRegister(0x32, 0x01)) return false; // soft reset
  delay(10);
  if (!writeAKRegister(0x31, 0x04)) return false; // Continuous measurement mode 2 (20Hz)
  Serial.println("AK09918 magnetometer initialized successfully.");
  return true;
}

bool readAK09918(float &mx, float &my, float &mz) {
  uint8_t st1 = 0;
  if (!readAKRegisters(0x10, &st1, 1)) return false;
  if (!(st1 & 0x01)) return false; // data not ready
  
  uint8_t buf[8];
  if (!readAKRegisters(0x11, buf, 8)) return false;
  
  int16_t raw_x = (int16_t)((uint16_t)buf[1] << 8 | buf[0]);
  int16_t raw_y = (int16_t)((uint16_t)buf[3] << 8 | buf[2]);
  int16_t raw_z = (int16_t)((uint16_t)buf[5] << 8 | buf[4]);
  
  uint8_t st2 = buf[7];
  if (st2 & 0x08) return false; // overflow
  
  mx = raw_x * 0.15f;
  my = raw_y * 0.15f;
  mz = raw_z * 0.15f;
  return true;
}
#endif



#define PART_BOUNDARY "123456789000000000000987654321"
static const char* _STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char* _STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
static const char* _STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n";

// Function to verify if connected to safe network
bool isNetworkVerified() {
  String currentSSID = WiFi.SSID();
  return (currentSSID == ssid1 || currentSSID == ssid2);
}

// Handler for MJPEG stream
esp_err_t stream_handler(httpd_req_t *req) {
#ifdef MOCK_CAMERA
  esp_err_t res = ESP_OK;
  char * part_buf[64];

  if (!isNetworkVerified()) {
    Serial.println("Security alert: Stream request rejected on unverified network!");
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Not on verified safe network");
    return ESP_FAIL;
  }

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) {
    return res;
  }

  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, private, max-age=0, no-store, must-revalidate");
  httpd_resp_set_hdr(req, "Pragma", "no-cache");
  httpd_resp_set_hdr(req, "Expires", "0");

  Serial.println("Client connected to mock stream");

  while (true) {
    if (!isNetworkVerified()) {
      Serial.println("Security alert: Wi-Fi SSID changed to unverified network during stream!");
      break;
    }

    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    }
    if (res == ESP_OK) {
      size_t hlen = snprintf((char *)part_buf, 64, _STREAM_PART, mock_jpg_len);
      res = httpd_resp_send_chunk(req, (const char *)part_buf, hlen);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)mock_jpg, mock_jpg_len);
    }

    if (res != ESP_OK) {
      break;
    }
    delay(200); // ~5 frames per second
  }

  Serial.println("Client disconnected from mock stream");
  return res;
#else
  camera_fb_t * fb = NULL;
  esp_err_t res = ESP_OK;
  size_t _jpg_buf_len = 0;
  uint8_t * _jpg_buf = NULL;
  char * part_buf[64];

  if (!isNetworkVerified()) {
    Serial.println("Security alert: Stream request rejected on unverified network!");
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Not on verified safe network");
    return ESP_FAIL;
  }

  res = httpd_resp_set_type(req, _STREAM_CONTENT_TYPE);
  if (res != ESP_OK) {
    return res;
  }

  // Set HTTP headers to prevent caching
  httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
  httpd_resp_set_hdr(req, "Cache-Control", "no-cache, private, max-age=0, no-store, must-revalidate");
  httpd_resp_set_hdr(req, "Pragma", "no-cache");
  httpd_resp_set_hdr(req, "Expires", "0");

  Serial.println("Client connected to stream");

  while (true) {
    // Check network security dynamically
    if (!isNetworkVerified()) {
      Serial.println("Security alert: Wi-Fi SSID changed to unverified network during stream!");
      break;
    }

    fb = esp_camera_fb_get();
    if (!fb) {
      Serial.println("Camera capture failed");
      res = ESP_FAIL;
      break;
    }

    _jpg_buf_len = fb->len;
    _jpg_buf = fb->buf;

    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, _STREAM_BOUNDARY, strlen(_STREAM_BOUNDARY));
    }
    if (res == ESP_OK) {
      size_t hlen = snprintf((char *)part_buf, 64, _STREAM_PART, _jpg_buf_len);
      res = httpd_resp_send_chunk(req, (const char *)part_buf, hlen);
    }
    if (res == ESP_OK) {
      res = httpd_resp_send_chunk(req, (const char *)_jpg_buf, _jpg_buf_len);
    }
    
    esp_camera_fb_return(fb);
    fb = NULL;

    if (res != ESP_OK) {
      break;
    }
  }

  Serial.println("Client disconnected from stream");
  return res;
#endif
}

// Handler for hardware controls (e.g. Flash LED)
esp_err_t control_handler(httpd_req_t *req) {
  char* buf;
  size_t buf_len;
  char var[32] = {0,};
  char val[32] = {0,};

  if (!isNetworkVerified()) {
    httpd_resp_send_err(req, HTTPD_403_FORBIDDEN, "Not on verified safe network");
    return ESP_FAIL;
  }

  buf_len = httpd_req_get_url_query_len(req) + 1;
  if (buf_len > 1) {
    buf = (char*)malloc(buf_len);
    if (!buf) {
      httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
      return ESP_FAIL;
    }
    if (httpd_req_get_url_query_str(req, buf, buf_len) == ESP_OK) {
      if (httpd_query_key_value(buf, "var", var, sizeof(var)) == ESP_OK &&
          httpd_query_key_value(buf, "val", val, sizeof(val)) == ESP_OK) {
        // Successfully parsed keys
      }
    }
    free(buf);
  }

  if (strcmp(var, "flash") == 0) {
    int val_int = atoi(val);
    if (FLASH_GPIO_NUM != -1) {
      bool pinState = val_int ? HIGH : LOW;
      if (FLASH_ACTIVE_LOW) {
        pinState = !pinState;
      }
      digitalWrite(FLASH_GPIO_NUM, pinState);
    }
    Serial.printf("Flash command received: %s\n", val_int ? "ON" : "OFF");
    
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_send(req, "OK", 2);
    return ESP_OK;
  }

  httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid variable or value");
  return ESP_FAIL;
}

void startCameraServer() {
  httpd_config_t config = HTTPD_DEFAULT_CONFIG();
  config.server_port = 80;
  config.ctrl_port = 32768;

  httpd_uri_t stream_uri = {
    .uri       = "/stream",
    .method    = HTTP_GET,
    .handler   = stream_handler,
    .user_ctx  = NULL
  };

  httpd_uri_t control_uri = {
    .uri       = "/control",
    .method    = HTTP_GET,
    .handler   = control_handler,
    .user_ctx  = NULL
  };

  Serial.printf("Starting stream server on port: '%d'\n", config.server_port);
  if (httpd_start(&stream_httpd, &config) == ESP_OK) {
    httpd_register_uri_handler(stream_httpd, &stream_uri);
    httpd_register_uri_handler(stream_httpd, &control_uri);
  }
}

void connectToWifi() {
  WiFi.mode(WIFI_STA); // Explicitly set to station mode to disable SoftAP SSID broadcast
  Serial.println("Attempting connection to WiFi network 1: Pumpkinpie");
  WiFi.begin(ssid1, pass1);
  
  int counter = 0;
  while (WiFi.status() != WL_CONNECTED && counter < 20) {
    delay(500);
    Serial.print(".");
    counter++;
  }
  Serial.println("");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Successfully connected to Pumpkinpie");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
    return;
  }

  Serial.println("Failed to connect to Pumpkinpie. Attempting connection to fallback network: Dobby");
  WiFi.disconnect();
  WiFi.begin(ssid2, pass2);

  counter = 0;
  while (WiFi.status() != WL_CONNECTED && counter < 20) {
    delay(500);
    Serial.print(".");
    counter++;
  }
  Serial.println("");

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("Successfully connected to fallback network Dobby");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Failed to connect to both networks. Will retry connection in loop...");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.setDebugOutput(true);
  Serial.println();

  // Initialize Flash LED GPIO pin
  if (FLASH_GPIO_NUM != -1) {
    pinMode(FLASH_GPIO_NUM, OUTPUT);
    digitalWrite(FLASH_GPIO_NUM, FLASH_ACTIVE_LOW ? HIGH : LOW); // Default to OFF
  }

#ifdef BOARD_WAVESHARE_ESP32
  Wire.begin(32, 33);
  if (ina219.begin()) {
    ina219_initialized = true;
    Serial.println("INA219 initialized successfully on Waveshare board.");
  } else {
    Serial.println("Warning: INA219 initialization failed on Waveshare board. Falling back to mock telemetry.");
  }

  if (imu.begin(Wire, 0x6A)) {
    imu_initialized = true;
    Serial.println("QMI8658 IMU initialized successfully (address 0x6A).");
  } else if (imu.begin(Wire, 0x6B)) {
    imu_initialized = true;
    Serial.println("QMI8658 IMU initialized successfully (address 0x6B).");
  } else {
    Serial.println("Warning: QMI8658 IMU initialization failed. Falling back to mock IMU telemetry.");
  }

  // Initialize AK09918 magnetometer
  ak09918_initialized = initAK09918();
#endif



#ifndef MOCK_CAMERA
  // Camera Config
  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  
  // Optimize settings based on PSRAM detection
  if (psramFound()) {
    config.frame_size = FRAMESIZE_QVGA; // Low latency, smooth driving size
    config.jpeg_quality = 10; // High clarity (lower value means higher quality)
    config.fb_count = 2; // Double buffering enables high framerates
    config.fb_location = CAMERA_FB_IN_PSRAM; // Explicitly allocate frame buffer in PSRAM
    config.grab_mode = CAMERA_GRAB_LATEST;   // Always grab the latest frame for lowest latency
    Serial.println("PSRAM detected! Configuring double-buffering, PSRAM buffer allocation, and CAMERA_GRAB_LATEST.");
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 14; // Lower quality to prevent out-of-memory errors
    config.fb_count = 1; // Single buffer fallback
    Serial.println("No PSRAM detected! Falling back to single-buffer configuration.");
  }

  // Camera Init
  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed with error 0x%x\n", err);
    return;
  }

  // Adjust camera sensor orientations
  sensor_t * s = esp_camera_sensor_get();
  if (s != NULL) {
    s->set_vflip(s, 1);
    s->set_hmirror(s, 1);
  }
#else
  Serial.println("Mock camera configured. Bypassing physical camera initialization.");
#endif

  // Establish Wi-Fi Connection
  connectToWifi();

  if (WiFi.status() == WL_CONNECTED) {
    // Start streaming and control server
    startCameraServer();
  }
}

void loop() {
  // Reconnect Wi-Fi if dropped
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi connection lost! Attempting to reconnect...");
    connectToWifi();
    if (WiFi.status() == WL_CONNECTED && stream_httpd == NULL) {
      startCameraServer();
    }
  }

  // Periodic UDP broadcast beacon
  if (WiFi.status() == WL_CONNECTED && isNetworkVerified()) {
    unsigned long currentMillis = millis();
    if (currentMillis - lastBeaconTime >= beaconInterval) {
      lastBeaconTime = currentMillis;

      IPAddress ip = WiFi.localIP();
      String deviceName = String(DEVICE_NAME);
      String beaconMsg;

#ifdef BOARD_WAVESHARE_ESP32
      float voltage = 0.0;
      float current = 0.0;
      float power = 0.0;
      float temp = 0.0;
      float ax = 0.0, ay = 0.0, az = 9.8;
      float gx = 0.0, gy = 0.0, gz = 0.0;

      if (ina219_initialized) {
        voltage = ina219.getBusVoltage_V();
        current = ina219.getCurrent_mA();
        power = voltage * current; // mW
      } else {
        // Fallback simulated sensor telemetry
        voltage = 11.5 + (random(0, 100) / 100.0);
        current = 100.0 + (random(0, 1000) / 10.0);
        power = voltage * current;
      }
      temp = 28.0 + (random(0, 100) / 10.0);

      float mx = 0.0, my = 0.0, mz = 0.0;

      if (imu_initialized) {
        imu.readAccel(ax, ay, az);
        imu.readGyro(gx, gy, gz);
      } else {
        // Mock shifting angles using sine waves
        unsigned long t = millis();
        ax = sin(t / 1000.0) * 200.0; // accel range -200 to 200 mg
        ay = cos(t / 1500.0) * 200.0;
        az = 1000.0 + sin(t / 2000.0) * 50.0; // gravity component at ~1000 mg
        gx = sin(t / 1000.0) * 10.0; // gyro range -10 to 10 dps
        gy = cos(t / 1500.0) * 10.0;
        gz = sin(t / 2500.0) * 5.0;
      }

      if (ak09918_initialized && readAK09918(mx, my, mz)) {
        // Magnetometer read succeeded
      } else {
        // Mock magnetometer values shifting slowly relative to simulated rotation
        unsigned long t = millis();
        float mockHeadingRad = (t / 2500.0); // full rotation every ~15 seconds
        mx = cos(mockHeadingRad) * 30.0; // typical field strength around 30-50 uT
        my = sin(mockHeadingRad) * 30.0;
        mz = -45.0; // vertical component
      }

      beaconMsg = "{\"device\":\"" + deviceName + "\",\"ip\":\"" + ip.toString() + "\",\"ssid\":\"" + WiFi.SSID() + "\",\"sensors\":{\"voltage\":" + String(voltage, 2) + ",\"current\":" + String(current, 1) + ",\"power\":" + String(power, 1) + ",\"temp\":" + String(temp, 1) + ",\"accel\":{\"x\":" + String(ax, 2) + ",\"y\":" + String(ay, 2) + ",\"z\":" + String(az, 2) + "},\"gyro\":{\"x\":" + String(gx, 2) + ",\"y\":" + String(gy, 2) + ",\"z\":" + String(gz, 2) + "},\"mag\":{\"x\":" + String(mx, 2) + ",\"y\":" + String(my, 2) + ",\"z\":" + String(mz, 2) + "}}}";

#else
      beaconMsg = "{\"device\":\"" + deviceName + "\",\"ip\":\"" + ip.toString() + "\",\"ssid\":\"" + WiFi.SSID() + "\"}";
#endif
      
      IPAddress broadcastIP(255, 255, 255, 255);
      udp.beginPacket(broadcastIP, udpPort);
      udp.print(beaconMsg);
      udp.endPacket();
    }
  }


  delay(10);
}
