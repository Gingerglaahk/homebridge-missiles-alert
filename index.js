var Service, Characteristic;
const request = require('request');
const DEF_INTERVAL = 2000; //2s

const URL = "https://api.tzevaadom.co.il/notifications";
const OREF_URL = "https://www.oref.org.il/warningMessages/alert/Alerts.json";
const HTTP_METHOD = "GET";
const HEADERS = {
    "Connection": "close",
    "X-Requested-With": "XMLHttpRequest",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
};

module.exports = function (homebridge) {
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    homebridge.registerAccessory("homebridge-missiles-alert", "MissilesAlert", HttpMotion);
}

function HttpMotion(log, config) {
    this.log = log;
    this.activeAlertIds = [];

    // Error counters
    this.httpErrorResponseCount = 0;
    this.jsonParseErrorCount = 0;
    this.updateStateResponsePendingCount = 0;

    // url info
    this.url = URL;
    this.http_method = HTTP_METHOD;
    this.headers = HEADERS;
    this.name = config["name"];
    this.manufacturer = "Gal Mirkin";
    this.model = "MissilesAlerts";
    this.serial = "RVU729";
    this.update_interval = Number(config["update_interval"] || DEF_INTERVAL);
    this.cities = config["cities"] || ["all"];

    // Internal variables
    this.last_state = false;
    this.waiting_response = false;
    this.activeAlertsEndTimes = {}; // Map of notificationId to end timestamp
}

HttpMotion.prototype = {
    updateState: function () {
        if (this.waiting_response) {
            this.updateStateResponsePendingCount++;
            if (this.updateStateResponsePendingCount >= 20) {
                this.updateStateResponsePendingCount = 0;
            }
            return;
        }
        this.updateStateResponsePendingCount = 0;
        this.waiting_response = true;

        var ops = {
            uri: this.url,
            method: this.http_method,
            headers: this.headers
        };

        var opsOref = {
            uri: OREF_URL,
            method: "GET",
            headers: {
                "Referer": "https://www.oref.org.il/",
                "X-Requested-With": "XMLHttpRequest",
                "Content-Type": "application/json"
            }
        };

        request(ops, (error, res, body) => {
            var value = false;
            var recentAlerts = [];

            if (error) {
                this.httpErrorResponseCount++;
                if (this.httpErrorResponseCount >= 10) {
                    this.log('HTTP bad response (' + ops.uri + ') occurred 10 times in a row: ' + error.message);
                    this.httpErrorResponseCount = 0;  // reset the counter
                }
            } else if (!body) {
                error = true;
            } else {
                try {
                    var alerts = JSON.parse(body);

                    var currentAlertsForCity = alerts.filter(alert => 
                        this.cities.includes("all") || alert.cities.some(city => this.cities.includes(city))
                    );

                    if (currentAlertsForCity.length > 0) {
                        currentAlertsForCity.forEach(alert => {
                            if (!this.activeAlertIds.includes(alert.notificationId)) {
                                this.log("Your city is under attack! Get to the shelters right now!");
                                this.activeAlertIds.push(alert.notificationId);
                                
                                // Set the default end time for this specific alert to 10 minutes (600s) buffer per Pikud Haoref guidelines
                                // Oref's explicit 'Clear' messages (cat 13) will override this if received sooner.
                                this.activeAlertsEndTimes[alert.notificationId] = Date.now() + (600 * 1000);
                            } else {
                                // If the alert is still actively reported by the API, reset its timer
                                // (This ensures the timer only really starts ticking down once the API stops reporting it, 
                                // or it ensures it at least stays active as long as the API says so)
                            }
                        });
                    }

                    this.httpErrorResponseCount = 0;
                    this.jsonParseErrorCount = 0;
                } catch (parseErr) {
                    this.jsonParseErrorCount++;
                    if (this.jsonParseErrorCount >= 10) {
                        this.log('Error processing received information occurred 10 times in a row: ' + parseErr.message);
                        this.jsonParseErrorCount = 0;
                    }
                    error = parseErr;
                }
            }

            // Also check OREF for "END" messages if there are active alerts
            if (this.activeAlertIds.length > 0) {
                request(opsOref, (errOref, resOref, bodyOref) => {
                    if (!errOref && bodyOref) {
                        try {
                            // Strip zero-width no-break space or bom if any
                            let text = bodyOref.replace(/^\uFEFF/, '').trim();
                            if (text) {
                                let orefData = JSON.parse(text);
                                // cat 13 is END message
                                if (orefData && (orefData.cat === "13" || orefData.cat === 13)) {
                                    let endCities = orefData.data || [];
                                    let endForConfigured = false;
                                    
                                    if (this.cities.includes("all")) {
                                        endForConfigured = true;
                                    } else {
                                        endForConfigured = endCities.some(c => this.cities.includes(c));
                                    }
                                    
                                    if (endForConfigured) {
                                        // End message received for our city, immediately clear active alerts
                                        this.log("Received 'Safe to leave shelter' message from Oref.");
                                        this.activeAlertIds = [];
                                        this.activeAlertsEndTimes = {};
                                    }
                                }
                            }
                        } catch(e) {
                            // Ignore oref parse errors, we can fallback to timeout
                        }
                    }
                    this._finalizeUpdate();
                });
            } else {
                this._finalizeUpdate();
            }
        });
    },

    _finalizeUpdate: function() {
        // Evaluate if any alerts are still active based on their end times
        let anyAlertActive = false;
        let now = Date.now();
        
        // Clean up expired alerts and check if any remain
        for (let i = this.activeAlertIds.length - 1; i >= 0; i--) {
            let alertId = this.activeAlertIds[i];
            let endTime = this.activeAlertsEndTimes[alertId];
            
            if (endTime && now < endTime) {
                anyAlertActive = true;
            } else {
                // Alert has expired
                this.activeAlertIds.splice(i, 1);
                delete this.activeAlertsEndTimes[alertId];
            }
        }
        
        var value = anyAlertActive;
        
        if (!value && this.last_state === true) {
            this.log("Alert over for your city. Safe to leave shelter.");
        }

        this.motionService
            .getCharacteristic(Characteristic.MotionDetected).updateValue(value, null, "updateState");
        this.last_state = value;
        this.waiting_response = false;
    },

    getState: function (callback) {
        var state = this.last_state;
        if (!this.waiting_response && this.update_interval === 0) {
            this.log('Call to getState: last_state is "' + state + '", will update state now');
            setImmediate(this.updateState.bind(this));
        }
        callback(null, state);
    },

    getServices: function () {
        this.log("Cities are set to " + this.cities.join(", "));
        this.informationService = new Service.AccessoryInformation();
        this.informationService
            .setCharacteristic(Characteristic.Manufacturer, this.manufacturer)
            .setCharacteristic(Characteristic.Model, this.model)
            .setCharacteristic(Characteristic.SerialNumber, this.serial);

        this.motionService = new Service.MotionSensor(this.name);
        this.motionService
            .getCharacteristic(Characteristic.MotionDetected)
            .on('get', this.getState.bind(this));

        if (this.update_interval > 0) {
            this.timer = setInterval(this.updateState.bind(this), this.update_interval);
        }

        return [this.informationService, this.motionService];
    }
};
