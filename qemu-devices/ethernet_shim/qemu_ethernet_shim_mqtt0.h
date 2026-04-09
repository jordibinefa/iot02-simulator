// qemu_ethernet_shim.h — Substitueix WiFi per Opencores Ethernet a QEMU ESP32
// Injectat automàticament pel backend del simulador durant la compilació.
//
// Disseny header-only: totes les implementacions estan en aquest fitxer,
// però protegides per #ifndef QEMU_ETHERNET_SHIM_IMPL_DONE per assegurar
// que s'instancien UNA SOLA VEGADA, des del .ino (on el backend injecta
// #define QEMU_ETHERNET_SHIM_IMPL abans del #include d'aquest fitxer).
//
// Per què header-only: arduino-cli no compila automàticament fitxers .cpp
// afegits dinàmicament al directori del sketch; només processa els que
// formaven part del projecte original.
//
// Compatibilitat: arduino-esp32 3.x (ESP-IDF 5.1, commit 632e0c2a9f)
// Requereix que el Dockerfile compili esp_eth_mac_openeth.c i l'afegeixi
// a libesp_eth.a, ja que arduino-esp32 no inclou CONFIG_ETH_USE_OPENETH=y.
// La signatura d'esp_eth_mac_new_openeth a IDF 5.1 és idèntica a IDF 4.x:
//   esp_eth_mac_t *esp_eth_mac_new_openeth(const eth_mac_config_t *config)

#ifndef QEMU_ETHERNET_SHIM_H
#define QEMU_ETHERNET_SHIM_H

#ifdef USING_ETHERNET_QEMU

#include <Arduino.h>
#include <esp_eth.h>
#include <esp_netif.h>
#include <esp_event.h>
#include <esp_mac.h>

// ─── Declaracions (visibles des de qualsevol unitat de compilació) ────────────

extern bool _qemu_eth_connected;
extern bool _qemu_eth_got_ip;
extern esp_netif_t* _qemu_eth_netif;

void _qemu_eth_event_handler(void* arg, esp_event_base_t event_base,
                              int32_t event_id, void* event_data);
void _qemu_init_ethernet();
void vSetupWifi();
String szGetMac();
boolean bTryWifiConnection();
void WiFiReset();
void vConnectToWiFi(const char* szSsid, const char* szPwd);
boolean bIsListed(String szSSID, int* pNwO);
void vDelayESP(unsigned long ulMilliseconds);

// ─── Macro QEMU_LOCAL_IP() ────────────────────────────────────────────────────
// Substitueix WiFi.localIP() per retornar la IP real de l'Ethernet emulat.
// El backend (server.js) substitueix WiFi.localIP() per QEMU_LOCAL_IP()
// en tots els fitxers .ino abans de compilar.
#define QEMU_LOCAL_IP() \
  (_qemu_eth_got_ip \
    ? ({ esp_netif_ip_info_t _qemu_ip; \
         esp_netif_get_ip_info(_qemu_eth_netif, &_qemu_ip); \
         IPAddress(_qemu_ip.ip.addr); }) \
    : IPAddress(0, 0, 0, 0))

#define WIFI_OVERRIDDEN_BY_QEMU

// ─── Implementacions (instanciades UNA VEGADA des del .ino) ──────────────────
// El backend afegeix   #define QEMU_ETHERNET_SHIM_IMPL
// just abans del       #include "qemu_ethernet_shim.h"
// al fitxer .ino, de manera que les implementacions es compilen exactament
// una vegada, dins la unitat de compilació del sketch principal.

#ifdef QEMU_ETHERNET_SHIM_IMPL
#ifndef QEMU_ETHERNET_SHIM_IMPL_DONE
#define QEMU_ETHERNET_SHIM_IMPL_DONE

#include <WiFi.h>  // Necessari per WiFiClient (usat per PubSubClient)

// Substituir WiFiClient per NetworkClient perquè PubSubClient usi la
// interfície Ethernet en lloc de la pila WiFi (no inicialitzada a QEMU).
// NetworkClient funciona amb qualsevol interfície de xarxa activa a 3.x.
// S'ha de definir DESPRÉS de WiFi.h per sobreescriure la seva definició.
#include <NetworkClient.h>
#define WiFiClient NetworkClient

// ─── Variables d'estat ───
bool _qemu_eth_connected = false;
bool _qemu_eth_got_ip    = false;
esp_netif_t* _qemu_eth_netif = NULL;

// ─── Gestor d'esdeveniments Ethernet ───
void _qemu_eth_event_handler(void* arg, esp_event_base_t event_base,
                               int32_t event_id, void* event_data) {
  if (event_base == ETH_EVENT) {
    switch (event_id) {
      case ETHERNET_EVENT_CONNECTED:
        Serial.println("[QEMU-ETH] Ethernet link up");
        _qemu_eth_connected = true;
        break;
      case ETHERNET_EVENT_DISCONNECTED:
        Serial.println("[QEMU-ETH] Ethernet link down");
        _qemu_eth_connected = false;
        _qemu_eth_got_ip    = false;
        break;
      default:
        break;
    }
  } else if (event_base == IP_EVENT && event_id == IP_EVENT_ETH_GOT_IP) {
    ip_event_got_ip_t* event = (ip_event_got_ip_t*)event_data;
    Serial.print("[QEMU-ETH] Got IP: ");
    Serial.println(IPAddress(event->ip_info.ip.addr));
    _qemu_eth_got_ip = true;
  }
}

// ─── Inicialització Opencores Ethernet (emulat per QEMU) ───
// Nota IDF 5.1: esp_netif_init() i esp_event_loop_create_default() poden
// retornar ESP_ERR_INVALID_STATE si el framework Arduino ja els ha cridat;
// aquest estat és normal i no és un error real.
void _qemu_init_ethernet() {
  esp_err_t ret;

  // esp_netif_init i esp_event_loop_create_default poden haver estat
  // cridats ja pel framework Arduino 3.x; ESP_ERR_INVALID_STATE és
  // acceptable en aquest cas.
  ret = esp_netif_init();
  if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
    Serial.printf("[QEMU-ETH] ERROR: esp_netif_init ha fallat (0x%x)\n", ret);
    return;
  }

  ret = esp_event_loop_create_default();
  if (ret != ESP_OK && ret != ESP_ERR_INVALID_STATE) {
    Serial.printf("[QEMU-ETH] ERROR: esp_event_loop_create_default ha fallat (0x%x)\n", ret);
    return;
  }

  esp_netif_config_t netif_cfg = ESP_NETIF_DEFAULT_ETH();
  _qemu_eth_netif = esp_netif_new(&netif_cfg);

  eth_mac_config_t mac_config = ETH_MAC_DEFAULT_CONFIG();

  // IDF 5.1: esp_eth_mac_new_openeth accepta un sol paràmetre,
  // igual que a IDF 4.x. L'adreça base del dispositiu Opencores
  // Ethernet és fixa i compatible amb QEMU (-nic user,model=open_eth).
  esp_eth_mac_t* mac = esp_eth_mac_new_openeth(&mac_config);
  if (!mac) {
    Serial.println("[QEMU-ETH] ERROR: No s'ha pogut crear la MAC Opencores Ethernet");
    Serial.println("[QEMU-ETH] Assegura't que QEMU s'inicia amb: -nic user,model=open_eth");
    return;
  }

  eth_phy_config_t phy_config = ETH_PHY_DEFAULT_CONFIG();
  phy_config.phy_addr       = 1;
  phy_config.reset_gpio_num = -1;
  // dp83848 és el PHY per defecte per a Opencores Ethernet a IDF 5.x.
  // Opencores Ethernet a QEMU no té PHY extern real, però el driver
  // necessita un objecte PHY per a la inicialització; dp83848 funciona.
  esp_eth_phy_t* phy = esp_eth_phy_new_dp83848(&phy_config);
  if (!phy) {
    Serial.println("[QEMU-ETH] dp83848 no disponible, provant lan87xx...");
    phy = esp_eth_phy_new_lan87xx(&phy_config);
  }
  if (!phy) {
    Serial.println("[QEMU-ETH] ERROR: No s'ha pogut crear el PHY");
    return;
  }

  esp_eth_config_t eth_config = ETH_DEFAULT_CONFIG(mac, phy);
  esp_eth_handle_t eth_handle = NULL;
  if (esp_eth_driver_install(&eth_config, &eth_handle) != ESP_OK) {
    Serial.println("[QEMU-ETH] ERROR: esp_eth_driver_install ha fallat");
    return;
  }

  esp_netif_attach(_qemu_eth_netif, esp_eth_new_netif_glue(eth_handle));

  esp_event_handler_register(ETH_EVENT, ESP_EVENT_ANY_ID,
                               &_qemu_eth_event_handler, NULL);
  esp_event_handler_register(IP_EVENT, IP_EVENT_ETH_GOT_IP,
                               &_qemu_eth_event_handler, NULL);

  esp_eth_start(eth_handle);

  // Esperar que el link estigui actiu ABANS d'assignar IP estàtica.
  // Si assignem IP abans del link up, esp_netif reporta "invalid static ip".
  Serial.println("[QEMU-ETH] Esperant Ethernet link up...");
  for (int i = 40; i > 0 && !_qemu_eth_connected; i--) {
    delay(250);
    Serial.print(".");
  }
  Serial.println();

  if (!_qemu_eth_connected) {
    Serial.println("[QEMU-ETH] AVÍS: Ethernet link no detectat, MQTT pot no connectar");
    return;
  }

  // Link up confirmat — ara assignem IP estàtica.
  // DHCP no funciona amb el driver OpenEth compilat amb stubs d'interrupció.
  // Xarxa slirp QEMU: 192.168.4.0/24, gateway/host: 192.168.4.1
  Serial.println("[QEMU-ETH] Configurant IP estàtica 192.168.4.2...");
  esp_netif_dhcpc_stop(_qemu_eth_netif);
  esp_netif_ip_info_t ip_info;
  IP4_ADDR(&ip_info.ip,      192, 168, 4,   2);
  IP4_ADDR(&ip_info.gw,      192, 168, 4,   1);
  IP4_ADDR(&ip_info.netmask, 255, 255, 255, 0);
  esp_err_t ip_ret = esp_netif_set_ip_info(_qemu_eth_netif, &ip_info);
  if (ip_ret != ESP_OK) {
    Serial.printf("[QEMU-ETH] AVÍS: esp_netif_set_ip_info retorna 0x%x\n", ip_ret);
  }

  _qemu_eth_got_ip = true;
  Serial.println("[QEMU-ETH] Xarxa llesta! IP: 192.168.4.2");
}

// ─── Overrides de les funcions WiFi ───

void vSetupWifi() {
  Serial.println("[QEMU] Saltant escaneig WiFi — usant Opencores Ethernet");
  _qemu_init_ethernet();
}

String szGetMac() {
  uint8_t mac[6];
  String szMAC = "";
  char szMac[3];
  esp_read_mac(mac, ESP_MAC_ETH);
  for (int i = 0; i < 6; i++) {
    if (mac[i] > 0x0F) sprintf(szMac, "%2X", mac[i]);
    else                sprintf(szMac, "0%X", mac[i]);
    szMAC += szMac;
  }
  return szMAC;
}

// Timestamp del moment en que es va rebre la IP
static unsigned long _qemu_eth_got_ip_ms = 0;

boolean bTryWifiConnection() {
  if (!_qemu_eth_got_ip) return false;
  // Esperar 500ms addicionals despres de rebre la IP perque el task
  // TCP/IP d'lwIP (ESP-IDF 5.x) estigui completament operatiu.
  // Sense aquest delay, tcpip_send_msg_wait_sem falla amb "Invalid mbox".
  if (_qemu_eth_got_ip_ms == 0) _qemu_eth_got_ip_ms = millis();
  if ((millis() - _qemu_eth_got_ip_ms) < 500) return false;
  return true;
}

void WiFiReset() {
  // No-op — Ethernet no necessita reset
}

void vConnectToWiFi(const char* szSsid, const char* szPwd) {
  Serial.println("[QEMU] vConnectToWiFi ignorada — usant Ethernet");
}

boolean bIsListed(String szSSID, int* pNwO) {
  return false;
}

void vDelayESP(unsigned long ulMilliseconds) {
  unsigned long ulPreviousMillis = millis();
  do { yield(); } while (millis() - ulPreviousMillis <= ulMilliseconds);
}

#endif // QEMU_ETHERNET_SHIM_IMPL_DONE
#endif // QEMU_ETHERNET_SHIM_IMPL

#endif // USING_ETHERNET_QEMU
#endif // QEMU_ETHERNET_SHIM_H
