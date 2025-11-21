// 获取SMWW.json
var SMWW = {};
var allCharacters = [];
$.getJSON('/SMWW.json', function(data) {
    SMWW = data;
    allCharacters = Object.keys(SMWW);
});