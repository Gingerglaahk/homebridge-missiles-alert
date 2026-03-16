const request = require('request');

request({
    uri: "https://api.tzevaadom.co.il/notifications",
    method: "GET",
    headers: {
        "Connection": "close",
        "X-Requested-With": "XMLHttpRequest",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
    }
}, (error, res, body) => {
    console.log(body);
});
