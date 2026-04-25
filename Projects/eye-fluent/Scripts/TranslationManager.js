// TranslationManager.js
// Captures a camera frame, sends it to a vision API, and forwards translation text to UIManager.

//@input Component.ScriptComponent uiManager {"hint":"Assign UIManager script component"}
//@input bool autoScan = true {"hint":"If true, scans repeatedly on interval"}
//@input float scanIntervalSeconds = 2.0 {"hint":"Seconds between scans when autoScan is true"}
//@input bool scanOnTap = false {"hint":"If true, a tap triggers one scan"}
//@input bool useAIPlaygroundGateway = true {"hint":"Use RemoteServiceGateway OpenAI integration from AI Playground"}
//@input string visionEndpoint = "https://api.openai.com/v1/chat/completions" {"hint":"Fallback endpoint when gateway is disabled/unavailable"}
//@input string apiKey {"hint":"Fallback bearer token for direct HTTP mode"}
//@input string modelName = "gpt-4o-mini" {"hint":"Vision model name"}
//@input bool enableDebugLogs = true

var cameraModule = require("LensStudio:CameraModule");
var internetModule = require("LensStudio:InternetModule");
var openAIModule = null;
var gatewayCredentialsModule = null;

try {
    openAIModule = require("RemoteServiceGateway.lspkg/HostedExternal/OpenAI");
} catch (e1) {
    openAIModule = null;
}

try {
    gatewayCredentialsModule = require("RemoteServiceGateway.lspkg/RemoteServiceGatewayCredentials");
} catch (e2) {
    gatewayCredentialsModule = null;
}

var cameraTexture = null;
var cameraTextureProvider = null;
var isCameraReady = false;
var isRequestInFlight = false;
var didBindAutoScan = false;

var TRANSLATION_PROMPT = "Find street signs in this image and translate the text to English. Return only the English translation.";

function log(message) {
    if (script.enableDebugLogs) {
        print("[TranslationManager] " + message);
    }
}

function getUIApi() {
    if (!script.uiManager || !script.uiManager.api) {
        return null;
    }
    return script.uiManager.api;
}

function setUIStatusScanning() {
    var ui = getUIApi();
    if (ui && ui.setScanning) {
        ui.setScanning();
    }
}

function setUIStatusNoTextFound() {
    var ui = getUIApi();
    if (ui && ui.setNoTextFound) {
        ui.setNoTextFound();
    }
}

function setUITranslation(text) {
    var ui = getUIApi();
    if (ui && ui.setTranslation) {
        ui.setTranslation(text);
    }
}

function initializeCamera() {
    try {
        var request = CameraModule.createCameraRequest();
        request.cameraId = CameraModule.CameraId.Default_Color;

        cameraTexture = cameraModule.requestCamera(request);
        if (!cameraTexture) {
            log("Failed to request camera texture.");
            return;
        }

        cameraTextureProvider = cameraTexture.control;
        if (cameraTextureProvider && cameraTextureProvider.onNewFrame) {
            cameraTextureProvider.onNewFrame.add(function() {
                if (isCameraReady) {
                    return;
                }

                var width = cameraTexture.getWidth();
                var height = cameraTexture.getHeight();
                if (width > 0 && height > 0) {
                    isCameraReady = true;
                    log("Camera ready (" + width + "x" + height + ").");
                }
            });
        }

        log("Camera requested.");
    } catch (error) {
        log("Camera initialization error: " + error);
    }
}

function encodeCurrentFrameAsBase64() {
    return new Promise(function(resolve, reject) {
        if (!cameraTexture || !isCameraReady) {
            reject("Camera is not ready");
            return;
        }

        Base64.encodeTextureAsync(
            cameraTexture,
            function(encodedString) {
                if (!encodedString || encodedString.length === 0) {
                    reject("Frame encoding returned empty output");
                    return;
                }
                resolve(encodedString);
            },
            function() {
                reject("Frame encoding failed");
            },
            CompressionQuality.IntermediateQuality,
            EncodingType.Jpg
        );
    });
}

function toDataUrl(base64Image) {
    if (base64Image.indexOf("data:image") === 0) {
        return base64Image;
    }
    return "data:image/jpeg;base64," + base64Image;
}

function parseOpenAIVisionResult(responseJson) {
    if (!responseJson || !responseJson.choices || responseJson.choices.length === 0) {
        return "";
    }

    var message = responseJson.choices[0].message;
    if (!message || !message.content) {
        return "";
    }

    if (typeof message.content === "string") {
        return message.content.trim();
    }

    if (message.content.length > 0 && message.content[0].text) {
        return message.content[0].text.trim();
    }

    return "";
}

function getOpenAIClientFromGateway() {
    if (!openAIModule) {
        return null;
    }

    if (openAIModule.OpenAI && openAIModule.OpenAI.chatCompletions) {
        return openAIModule.OpenAI;
    }

    if (openAIModule.chatCompletions) {
        return openAIModule;
    }

    return null;
}

function getConfiguredApiKey() {
    if (script.apiKey && script.apiKey.length > 0) {
        return script.apiKey;
    }

    if (!gatewayCredentialsModule || !gatewayCredentialsModule.RemoteServiceGatewayCredentials) {
        return "";
    }

    var credentials = gatewayCredentialsModule.RemoteServiceGatewayCredentials;

    // The AI Playground reads credentials from RemoteServiceGatewayCredentials.
    // This keeps Eye-Fluent compatible with the same setup.
    if (credentials.openAIToken && credentials.openAIToken.length > 0) {
        return credentials.openAIToken;
    }

    if (credentials.getApiToken && gatewayCredentialsModule.AvaliableApiTypes) {
        var openAIType = gatewayCredentialsModule.AvaliableApiTypes.OpenAI;
        return credentials.getApiToken(openAIType);
    }

    return "";
}

function buildVisionPayload(base64Image) {
    return {
        model: script.modelName,
        messages: [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: TRANSLATION_PROMPT
                    },
                    {
                        type: "image_url",
                        image_url: {
                            url: toDataUrl(base64Image)
                        }
                    }
                ]
            }
        ],
        max_tokens: 80
    };
}

function sendWithAIPlaygroundOpenAI(payload) {
    var openAIClient = getOpenAIClientFromGateway();
    if (!openAIClient) {
        return Promise.reject("RemoteServiceGateway OpenAI module is unavailable");
    }

    return openAIClient.chatCompletions(payload).then(function(response) {
        return parseOpenAIVisionResult(response);
    });
}

function sendWithDirectFetch(payload) {
    var resolvedApiKey = getConfiguredApiKey();
    if (!resolvedApiKey) {
        return Promise.reject("No API key configured");
    }

    return internetModule
        .fetch(script.visionEndpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Bearer " + resolvedApiKey
            },
            body: JSON.stringify(payload)
        })
        .then(function(response) {
            if (!response || !response.ok) {
                throw "Vision API request failed";
            }
            return response.json();
        })
        .then(function(data) {
            return parseOpenAIVisionResult(data);
        });
}

function sendImageToVisionApi(base64Image) {
    var payload = buildVisionPayload(base64Image);

    if (script.useAIPlaygroundGateway) {
        return sendWithAIPlaygroundOpenAI(payload).catch(function(gatewayError) {
            log("Gateway path failed, falling back to direct fetch: " + gatewayError);
            return sendWithDirectFetch(payload);
        });
    }

    return sendWithDirectFetch(payload);
}

function runTranslationScan() {
    if (isRequestInFlight) {
        return;
    }

    isRequestInFlight = true;
    setUIStatusScanning();

    encodeCurrentFrameAsBase64()
        .then(function(base64Image) {
            return sendImageToVisionApi(base64Image);
        })
        .then(function(translatedText) {
            if (!translatedText || translatedText.length === 0) {
                setUIStatusNoTextFound();
                return;
            }
            setUITranslation(translatedText);
        })
        .catch(function(error) {
            log("Translation scan failed: " + error);
            setUIStatusNoTextFound();
        })
        .then(function() {
            isRequestInFlight = false;
        });
}

function setupAutoScanEvent() {
    if (!script.autoScan || didBindAutoScan) {
        return;
    }

    var delayEvent = script.createEvent("DelayedCallbackEvent");
    delayEvent.bind(function() {
        runTranslationScan();
        delayEvent.reset(script.scanIntervalSeconds);
    });
    delayEvent.reset(script.scanIntervalSeconds);
    didBindAutoScan = true;
}

function setupTapToScanEvent() {
    if (!script.scanOnTap) {
        return;
    }

    var tapEvent = script.createEvent("TapEvent");
    tapEvent.bind(function() {
        runTranslationScan();
    });
}

script.api.scanNow = function() {
    runTranslationScan();
};

function onStart() {
    if (script.useAIPlaygroundGateway) {
        log("Using AI Playground RemoteServiceGateway integration.");
    } else if (!script.apiKey || script.apiKey.length === 0) {
        log("No fallback API key configured. Assign apiKey in Inspector.");
    }

    initializeCamera();
    setupAutoScanEvent();
    setupTapToScanEvent();
}

script.createEvent("OnStartEvent").bind(onStart);
