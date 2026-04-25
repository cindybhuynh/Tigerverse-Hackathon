// UIManager.js
// Displays translation states and result text in either Screen Text or Text3D.

//@input Component.Text screenText {"hint":"Optional Screen Text component"}
//@input Component.Text3D text3D {"hint":"Optional Text3D component"}
//@input SceneObject textRoot {"hint":"Optional parent object to reposition text higher in view"}
//@input vec3 upperFovLocalOffset = {x:0.0, y:8.0, z:0.0} {"hint":"Local offset applied to textRoot on start"}
//@input bool enableDebugLogs = true

var DEFAULT_IDLE_TEXT = "Look at a sign to translate";
var DEFAULT_SCANNING_TEXT = "Scanning...";
var DEFAULT_EMPTY_TEXT = "No text found";

function log(message) {
    if (script.enableDebugLogs) {
        print("[UIManager] " + message);
    }
}

function getActiveTextComponent() {
    if (script.screenText) {
        return script.screenText;
    }
    if (script.text3D) {
        return script.text3D;
    }
    return null;
}

function applyText(message) {
    var target = getActiveTextComponent();
    if (!target) {
        log("No text component assigned.");
        return;
    }

    target.text = message;
}

script.api.setIdle = function() {
    applyText(DEFAULT_IDLE_TEXT);
};

script.api.setScanning = function() {
    applyText(DEFAULT_SCANNING_TEXT);
};

script.api.setNoTextFound = function() {
    applyText(DEFAULT_EMPTY_TEXT);
};

script.api.setTranslation = function(translatedText) {
    var safeText = translatedText ? translatedText : DEFAULT_EMPTY_TEXT;
    applyText(safeText);
};

script.api.setStatus = function(statusText) {
    applyText(statusText);
};

function setUpperFovPositionIfConfigured() {
    if (!script.textRoot) {
        return;
    }

    var transform = script.textRoot.getTransform();
    transform.setLocalPosition(script.upperFovLocalOffset);
}

function onStart() {
    setUpperFovPositionIfConfigured();
    script.api.setIdle();
    log("UI initialized.");
}

script.createEvent("OnStartEvent").bind(onStart);
