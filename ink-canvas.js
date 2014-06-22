/* global Windows */
/* global WinJS */
/* global Debug */
(function (window, Windows, WinJS, Debug) {
    "use strict";

    window.InkCanvas = function() {
        var self = this;

        // Error handler and message handler to be passed in
        var onError = function (ex) {
            throw ex;
        };
        var sendNotification = function (message) {
            Debug.writeln(message);
        };

        // Variables representing the ink interface.
        // The usage of a global variable for drawingAttributes is not completely necessary,
        // just a convenience.  One could always re-fetch the current drawingAttributes
        // from the inkManager.
        var inkManager = new Windows.UI.Input.Inking.InkManager();
        var drawingAttributes = new Windows.UI.Input.Inking.InkDrawingAttributes();
        drawingAttributes.fitToCurve = true;
        inkManager.setDefaultDrawingAttributes(drawingAttributes);

        // This is the canvas for drawing ink and its 2d context
        var inkCanvas = null;
        var inkContext = null;

        // Global memory of the current pointID (for pen, and, separately, for touch).
        // We ignore handlePointerMove() and handlePointerUp() calls that don't use the same
        // pointID as the most recent handlePointerDown() call.  This is because the user sometimes
        // accidentally nudges the mouse while inking or touching.  This can cause move events
        // for that mouse that have different x,y coordinates than the ink trace or touch path
        // we are currently handling.

        // pointer* events maintain this pointId so that one can track individual fingers,
        // the pen, and the mouse.

        // Note that when the pen fails to leave the area where it can be sensed, it does NOT
        // get a new ID; so it is possible for 2 or more consecutive strokes to have the same ID.
        var penID = -1;

        // The "mode" of whether we are inking or erasing is controlled by this global variable,
        // which should be pointing to inkContext.
        var context = null;

        // Note that we can get into erasing mode in one of two ways: there is a eraser button in the toolbar,
        // and some pens have an active back end that is meant to represent erasing.  If we get into erasing
        // mode via the button, we stay in that mode until another button is pushed.  If we get into erasing
        // mode via the eraser end of the stylus, we should switch out of it when the user switches to the ink
        // end of the stylus.  And we want to return to the mode we were in before this happened.  Thus we
        // maintain a shallow stack (depth 1) of "mode" info.

        var savedContext = null;
        var savedStyle = null;
        var savedMode = null;

        // Dictionary of chars to lists of chars
        // If any of the letters in the list is detected by handwriting recognition
        // it should accept the char key as input.
        // Otherwise it will notify a list of conversions every time handwriting recognition occurs.
        var conversionDictionary = null;

        // Keeps track of whether we have already called clear (clear is usually called on a timeout to give the user
        // more time to finish inking)
        // if so there is no need to schedule another clear
        var queuedClear = null;

        // The default value for clearTimeout is 1000 ms
        // This can be overridden by the configuration in initializeInk()
        // This is how long we should wait before clearing invalid input
        // It will be reset as soon as the user touches, clicks, or draws on the canvas
        var clearTimeoutDuration = 1000;

        //handwritingRecognitionCallback depends upon conversionDictionary being set for it to work

        // This is an optional callback the user can send in when initializing ink.
        // It is called with the string that was recognized whenever valid handwriting is recognized
        // If the callback is not null it will expect a true or false return value
        // The return value decides whether the string should be accepted as input
        // If false the handwriting will be cleared
        var handwritingRecognitionCallback = null;

        // Functions to convert from and to the 32-bit int used to represent color in Windows.UI.Input.Inking.InkManager.

        // Convenience function used by color converters.
        // Assumes arg num is a number (0..255); we convert it into a 2-digit hex string.
        function byteHex(num)
        {
            var hex = num.toString(16);
            if (hex.length === 1)
            {
                hex = "0" + hex;
            }
            return hex;
        }

        // Convert from Windows.UI.Input.Inking's color code to html's color hex string.
        function toColorString(color)
        {
            return "#" + byteHex(color.r) + byteHex(color.g) + byteHex(color.b);
        }

        // Convert from the few color names used in this app to Windows.UI.Input.Inking's color code.
        // If it isn't one of those, then decode the hex string.  Otherwise return gray.
        // The alpha component is always set to full (255).
        function toColorStruct(color)
        {
            switch (color)
            {
            // Ink colors
            case "Black":
                return Windows.UI.Colors.black;
            case "Blue":
                return Windows.UI.Colors.blue;
            case "Red":
                return Windows.UI.Colors.red;
            case "Green":
                return Windows.UI.Colors.green;

            // Highlighting colors
            case "Yellow":
                return Windows.UI.Colors.yellow;
            case "Aqua":
                return Windows.UI.Colors.aqua;
            case "Lime":
                return Windows.UI.Colors.lime;

            // Select colors
            case "Gold":
                return Windows.UI.Colors.gold;

            case "White":
                return Windows.UI.Colors.white;
            }

            if ((color.length === 7) && (color.charAt(0) === "#"))
            {
                var R = parseInt(color.substr(1, 2), 16);
                var G = parseInt(color.substr(3, 2), 16);
                var B = parseInt(color.substr(5, 2), 16);
                return Windows.UI.ColorHelper.fromArgb(255, R, G, B);
            }

            return Windows.UI.Colors.gray;
        }

        // There are 2 modes: temporary erase mode and ink mode
        // These functions clear, save, and restore the current mode
        // More modes could be added for more functionality
        // Look at the microsoft ink samples for highlight, select, and erase modes

        function clearMode() {
            savedContext = null;
            savedStyle = null;
            savedMode = null;
        }

        function saveMode() {
            if (!savedContext) {
                savedStyle = context.strokeStyle;
                savedContext = context;
                savedMode = inkManager.mode;
            }
        }

        function restoreMode() {
            if (savedContext) {
                context = savedContext;
                context.strokeStyle = savedStyle;
                inkManager.mode = savedMode;
                clearMode();
            }
        }

        // 2 functions to switch back and forth between ink mode and a temp erase mode, which uses the saveMode()/restoreMode() functions to
        // return us to our previous mode when done erasing.  This is used for quick erasers using the back end
        // of the pen (for those pens that have that).
        // NOTE: The erase modes also attempt to set the mouse/pen cursor to the image of a chalkboard eraser
        // (stored in images/erase.cur), but as of this writing cursor switching is not working (the cursor switching part may have been removed).
        function inkMode()
        {
            clearMode();
            context = inkContext;
            inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
            setDefaults();
        }

        function tempEraseMode()
        {
            saveMode();
            inkContext.strokeStyle = "rgba(255,255,255,0.0)";
            context = inkContext;
            inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
        }

        // Note that we cannot just set the width in stroke.drawingAttributes.size.width,
        // or the color in stroke.drawingAttributes.color.
        // The stroke API supports get and put operations for drawingAttributes,
        // but we must execute those operations separately, and change any values
        // inside drawingAttributes between those operations.

        // Change the color and width in the default (used for new strokes) to the values
        // currently set in the current context.
        function setDefaults()
        {
            var strokeSize = drawingAttributes.size;
            strokeSize.width = strokeSize.height = context.lineWidth;
            drawingAttributes.size = strokeSize;

            var color = toColorStruct(context.strokeStyle);
            drawingAttributes.color = color;
            inkManager.setDefaultDrawingAttributes(drawingAttributes);
        }

        //Event handler region
        var EventHandler = {
            // We will accept pen down, mouse left down, or touch down as the start of a stroke.
            handlePointerDown : function(evt) {
                try {
                    resetClearQueue();
                    if (evt.button === 0) {
                        // Clear any current selection.
                        var pt = { x: 0.0, y: 0.0 };
                        inkManager.selectWithLine(pt, pt);

                        pt = evt.currentPoint;

                        // the back side of a pen, which we treat as an eraser
                        if (pt.properties.isEraser)
                        {
                            tempEraseMode();
                        }
                        else {
                            restoreMode();
                        }

                        context.beginPath();
                        context.moveTo(pt.rawPosition.x, pt.rawPosition.y);

                        inkManager.processPointerDown(pt);
                        penID = evt.pointerId;
                    }
                }
                catch (e) {
                    onError(e);
                }
            },

            handlePointerMove : function(evt) {
                try {
                    if (evt.pointerId === penID) {
                        var pt = evt.currentPoint;
                        context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        context.stroke();
                        // Get all the points we missed and feed them to inkManager.
                        // The array pts has the oldest point in position length-1; the most recent point is in position 0.
                        // Actually, the point in position 0 is the same as the point in pt above (returned by evt.currentPoint).
                        var pts = evt.intermediatePoints;
                        for (var i = pts.length - 1; i >= 0 ; i--) {
                            inkManager.processPointerUpdate(pts[i]);
                        }
                    }
                }
                catch (e) {
                    onError(e);
                }
            },

            handlePointerUp : function(evt) {
                try {
                    if (evt.pointerId === penID) {
                        penID = -1;
                        var pt = evt.currentPoint;
                        context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        context.stroke();
                        context.closePath();

                        inkManager.processPointerUp(pt);

                        renderAllStrokes();
                    }
                }
                catch (e) {
                    onError(e);
                }
            },

            // We treat the event of the pen leaving the canvas as the same as the pen lifting;
            // it completes the stroke.
            handlePointerOut : function(evt) {
                try {
                    if (evt.pointerId === penID) {
                        var pt = evt.currentPoint;
                        context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        context.stroke();
                        context.closePath();
                        inkManager.processPointerUp(pt);
                        penID = -1;
                        renderAllStrokes();
                    }
                }
                catch (e) {
                    onError(e);
                }
            }
        };

        // Redraws (from the beginning) all strokes in the canvases.  All canvases are erased,
        // then the paper is drawn, then all the strokes are drawn.
        // dontFind determines whether we should perform handwriting recognition
        function renderAllStrokes(dontFind)
        {
            inkContext.clearRect(0, 0, inkCanvas.width, inkCanvas.height);

            inkManager.getStrokes().forEach(function (stroke)
            {
                var att = stroke.drawingAttributes;
                var color = toColorString(att.color);
                var strokeSize = att.size;
                var width = strokeSize.width;
                renderStroke(stroke, color, width, inkContext);
            });

            if (!dontFind) {
                find();
            }
        }

        // Draws a single stroke into a specified canvas 2D context, with a specified color and width.
        function renderStroke(stroke, color, width, ctx) {
            ctx.save();

            try {
                ctx.beginPath();
                ctx.strokeStyle = color;
                ctx.lineWidth = width;

                var first = true;
                stroke.getRenderingSegments().forEach(function (segment) {
                    if (first) {
                        ctx.moveTo(segment.position.x, segment.position.y);
                        first = false;
                    }
                    else {
                        ctx.bezierCurveTo(segment.bezierControlPoint1.x, segment.bezierControlPoint1.y,
                                          segment.bezierControlPoint2.x, segment.bezierControlPoint2.y,
                                          segment.position.x, segment.position.y);
                    }
                });

                ctx.stroke();
                ctx.closePath();

                ctx.restore();
            }
            catch (e) {
                ctx.restore();
                onError(e);
            }
        }

        // Makes all strokes a part of the selection.
        function selectAllStrokes()
        {
            inkManager.getStrokes().forEach(function (stroke) {
                stroke.selected = true;
            });
        }

        // Clears the canvas of all strokes
        self.clear = function()
        {
            try
            {
                selectAllStrokes();
                inkManager.deleteSelected();
                inkMode();

                renderAllStrokes(true);
            }
            catch (e)
            {
                onError(e);
            }
        };

        // Prevents any queued calls to clear from happening
        // then empties the queue
        function resetClearQueue() {
            if (queuedClear) {
                window.clearTimeout(queuedClear);
                queuedClear = null;
            }
        }

        // Calls asynchronous handwriting recognition, which returns a list of results.
        // Each result has a list of potential text candidates.
        // We use the conversion dictionary to check against all potential text candidates
        // to see if we have valid input.

        // If the handwriting is recognized as valid input we call handwritingRecognitionCallback
        function find() {
            try {
                resetClearQueue();
                inkManager.recognizeAsync(Windows.UI.Input.Inking.InkRecognitionTarget.all).done
                (
                    function (results) {
                        var i, valid;
                        inkManager.updateRecognitionResults(results);


                        if (conversionDictionary) {
                            valid = checkForValidRecognitionResults(results);
                            if (valid) {
                                if (handwritingRecognitionCallback && !handwritingRecognitionCallback(valid)) {
                                    // Means there is a callback and the callback rejected the input
                                    // so we should clear the canvas immediately
                                    self.clear();
                                    resetClearQueue();
                                }
                                sendNotification("Found valid conversion: " + valid);
                            } else {
                                // Give the user some time to make their input valid.
                                // Clear the canvas if they do not respond in time
                                if (queuedClear) {
                                    clearTimeout();
                                }
                                queuedClear = window.setTimeout(self.clear, clearTimeoutDuration);
                            }
                        } else {
                            for (i = 0; i < results.length; i++) {
                                sendNotification("Results: " + results[i].getTextCandidates().join());
                            }
                        }
                    },
                    function (e) {
                        onError(e);
                    }
                );
            }
            catch (e) {
                onError(e);
            }
            return false;
        }

        // Checks the handwriting recognition results for valid input according to the conversion dictionary.
        // If any valid input is found, the appropriate key from the conversion dictionary is returned.
        function checkForValidRecognitionResults(recognitionResults) {
            var i, j, key, m, textCandidates;
            for (i = 0; i < recognitionResults.length; i++) {
                textCandidates = recognitionResults[i].getTextCandidates();
                for (j = 0; j < textCandidates.length; j++) {
                    for (key in conversionDictionary) {
                        for (m = 0; m < conversionDictionary[key].length; m++) {
                            if (textCandidates[j] == conversionDictionary[key][m]) {
                                return key;
                            }
                        }
                    }
                }
            }
            return false;
        }

        // Finds a specific recognizer, and sets the inkManager's default to that recognizer.
        // Returns true if successful.
        function setRecognizerByName (recname)
        {
            try
            {
                // recognizers is a normal JavaScript array
                var recognizers = inkManager.getRecognizers();
                for (var i = 0, len = recognizers.length; i < len; i++)
                {
                    if (recname === recognizers[i].name)
                    {
                        inkManager.setDefaultRecognizer(recognizers[i]);
                        return true;
                    }
                }
            }
            catch (e)
            {
                onError(e);
            }
            return false;
        }

        // elementId is the ID of the element that the canvas should be initialized in
        // (optional) configuration is an object with the following properties:
        //  errorHandler is a function that accepts an exception as the only argument
        //  messageHandler is a function that accepts a string as the only argument
        //  alphabetDictionary defines the language that should be accepted as input by handwriting recognition
        //      the dictionary should have chars for keys and lists of chars as values.
        //      if any char in the value list is detected by handwriting recognition InkCanvas will accept the key char as input
        //  recognitionCallback is a function that accepts a string for when handwriting has been recognized as valid input
        //  clearTimeoutDuration is the amount of time in milliseconds to wait before clearing the canvas if the input is invalid

        // Sample configuration:
        // {
        //  errorHandler : function(ex) { throw ex; },
        //  messageHandler: function(message) { Debug.writeLn(message); },
        //  alphabetDictionary : [
        //      "X": ["x","X","%","T","t"],
        //      "O": ["o","O","0","Q"]
        //  ],
        //  recognitionCallback: function(value) { Debug.writeLn("Input recognized: " + value); },
        //  clearTimeoutDuration: 2000
        // }
        self.initializeInk = function (elementId, configuration) {
            if (configuration) {
                if (configuration.errorHandler) {
                    onError = configuration.errorHandler;
                }
                if (configuration.messageHandler) {
                    sendNotification = configuration.messageHandler;
                }

                conversionDictionary = configuration.alphabetDictionary;

                handwritingRecognitionCallback = configuration.recognitionCallback;

                if (configuration.clearTimeoutDuration) {
                    clearTimeoutDuration = configuration.clearTimeoutDuration;
                }
            }

            WinJS.UI.processAll().then(
                function () {
                    var parent = document.getElementById(elementId);
                    var canvasElement = document.createElement("canvas");
                    parent.appendChild(canvasElement);

                    inkCanvas = canvasElement;
                    inkCanvas.gestureObject = new window.MSGesture();
                    inkCanvas.gestureObject.target = inkCanvas;
                    inkCanvas.setAttribute("width", inkCanvas.offsetWidth);
                    inkCanvas.setAttribute("height", inkCanvas.offsetHeight);
                    inkCanvas.style.backgroundColor = "White";
                    inkContext = inkCanvas.getContext("2d");
                    inkContext.lineWidth = 2;
                    inkContext.strokeStyle = "Black";
                    inkContext.lineCap = "round";
                    inkContext.lineJoin = "round";

                    inkCanvas.addEventListener("pointerdown", EventHandler.handlePointerDown, false);
                    inkCanvas.addEventListener("pointerup", EventHandler.handlePointerUp, false);
                    inkCanvas.addEventListener("pointermove", EventHandler.handlePointerMove, false);
                    inkCanvas.addEventListener("pointerout", EventHandler.handlePointerOut, false);
                    inkCanvas.addEventListener("MSGestureStart", EventHandler.handlePointerDown, false);
                    inkCanvas.addEventListener("MSGestureEnd", EventHandler.handlePointerUp, false);

                    if (!setRecognizerByName("Microsoft English (US) Handwriting Recognizer")) {
                        sendNotification("Failed to find English (US) recognizer");
                    }

                    inkMode();
                }
            ).done(
                function () {
                },
                function (e) {
                    onError(e);
                }
            );
        };

        return self;
    };
}(window, Windows, WinJS, Debug));