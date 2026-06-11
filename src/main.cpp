#include "esp_camera.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include "esp_http_server.h"

// AI-Thinker Camera Pin Definitions
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

// Flash LED pin
#define FLASH_GPIO_NUM     4

// Wi-Fi details
const char* ssid1 = "Pumpkinpie";
const char* pass1 = "dobbyaspenindy";
const char* ssid2 = "Dobby";
const char* pass2 = "sanmina-1";

// UDP details for broadcast discovery
WiFiUDP udp;
const int udpPort = 3000;
unsigned long lastBeaconTime = 0;
const unsigned long beaconInterval = 2000; // 2 seconds

httpd_handle_t stream_httpd = NULL;

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
    digitalWrite(FLASH_GPIO_NUM, val_int ? HIGH : LOW);
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
  pinMode(FLASH_GPIO_NUM, OUTPUT);
  digitalWrite(FLASH_GPIO_NUM, LOW); // Flash light default to OFF

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
    Serial.println("PSRAM detected! Configuring double-buffering & high-quality QVGA.");
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
      String beaconMsg = "{\"device\":\"esp32cam\",\"ip\":\"" + ip.toString() + "\",\"ssid\":\"" + WiFi.SSID() + "\"}";
      
      IPAddress broadcastIP(255, 255, 255, 255);
      udp.beginPacket(broadcastIP, udpPort);
      udp.print(beaconMsg);
      udp.endPacket();
    }
  }

  delay(10);
}
