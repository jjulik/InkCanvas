/* global Windows */
/* global WinJS */
(function (global, Windows, WinJS) {
    "use strict";

    global.InkCanvas = function() {
        var self = this;

        // Error handler and message handler to be passed in
        self.onError = function (ex) {
            throw ex;
        };
        self.sendNotification = function (message) {
        };

        // Variables representing the ink interface.
        // The usage of a global variable for drawingAttributes is not completely necessary,
        // just a convenience.  One could always re-fetch the current drawingAttributes
        // from the inkManager.
        self.inkManager = new Windows.UI.Input.Inking.InkManager();
        self.drawingAttributes = new Windows.UI.Input.Inking.InkDrawingAttributes();
        self.drawingAttributes.fitToCurve = true;
        self.inkManager.setDefaultDrawingAttributes(self.drawingAttributes);

        // These are the global canvases (and their 2D contexts) for highlighting, for drawing ink,
        // and for lassoing (and erasing).
        self.inkCanvas = null;
        self.inkContext = null;

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

        self.penID = -1;

        // The "mode" of whether we are highlighting, inking, lassoing, or erasing is controlled by this global variable,
        // which should be pointing to either hlContext, inkContext, or selContext.
        // In lassoing mode (when context points to selContext), we might also be in erasing mode;
        // the state of lassoing vs. erasing is kept inside the ink manager, in attribute "mode", which will
        // have a value from enum Windows.UI.Input.Inking.InkManipulationMode, one of either "selecting"
        // or "erasing" (the other value being "inking" but in that case context will be pointing to one of the other
        // 2 canvases).
        self.context = null;

        // Global variable representing the pattern used when in select mode.  This is an 8*1 image with 4 bits set,
        // then 4 bits cleared, to give us a dashed line when drawing a lasso.
        self.selPattern = null;

        // Event handlers
        self.EventHandler = null;

        // Note that we can get into erasing mode in one of two ways: there is a eraser button in the toolbar,
        // and some pens have an active back end that is meant to represent erasing.  If we get into erasing
        // mode via the button, we stay in that mode until another button is pushed.  If we get into erasing
        // mode via the eraser end of the stylus, we should switch out of it when the user switches to the ink
        // end of the stylus.  And we want to return to the mode we were in before this happened.  Thus we
        // maintain a shallow stack (depth 1) of "mode" info.

        self.savedContext = null;
        self.savedStyle = null;
        self.savedMode = null;

        //dictionary of chars to lists of chars
        //if any of the letters in the list is detected by handwriting recognition
        //it should accept the char key as input
        //Otherwise it will notify a list of conversions every time handwriting recognition occurs
        self.conversionDictionary = null;

        // Keeps track of whether we have already called clear (clear is usually called on a 1000 ms timeout to give the user
        // more time to finish inking)
        // if so there is no need to schedule another clear
        self.queuedClear = null;

        //handwritingRecognitionCallback depends upon conversionDictionary being set for it to work

        // This is an optional callback the user can send in when initializing ink.
        // It is called with the string that was recognized whenever valid handwriting is recognized
        // If the callback is not null it will expect a true or false return value
        // The return value decides whether the string should be accepted as input
        // If false the handwriting will be cleared
        self.handwritingRecognitionCallback = null;

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

        function clearMode()
        {
            self.savedContext = null;
            self.savedStyle = null;
            self.savedCursor = null;
            self.savedMode = null;
        }

        function saveMode()
        {
            if (!self.savedContext)
            {
                self.savedStyle = self.context.strokeStyle;
                self.savedContext = self.context;
                self.savedMode = self.inkManager.mode;
            }
        }

        function restoreMode()
        {
            if (self.savedContext)
            {
                self.context = self.savedContext;
                self.context.strokeStyle = self.savedStyle;
                self.inkManager.mode = self.savedMode;
                clearMode();
            }
        }

        // 2 functions to switch back and forth between ink mode and a temp erase mode, which uses the saveMode()/restoreMode() functions to
        // return us to our previous mode when done erasing.  This is used for quick erasers using the back end
        // of the pen (for those pens that have that).
        // NOTE: The erase modes also attempt to set the mouse/pen cursor to the image of a chalkboard eraser
        // (stored in images/erase.cur), but as of this writing cursor switching is not working (the cursor switching part may have been removed).

        self.inkMode = function()
        {
            clearMode();
            self.context = self.inkContext;
            self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
            setDefaults();
        };

        function tempEraseMode()
        {
            saveMode();
            self.inkContext.strokeStyle = "rgba(255,255,255,0.0)";
            self.context = self.inkContext;
            self.inkManager.mode = self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
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
            var strokeSize = self.drawingAttributes.size;
            strokeSize.width = strokeSize.height = self.context.lineWidth;
            self.drawingAttributes.size = strokeSize;

            var color = toColorStruct(self.context.strokeStyle);
            color.a = 255;
            self.drawingAttributes.color = color;
            self.inkManager.setDefaultDrawingAttributes(self.drawingAttributes);
        }

        //Event handler region
        self.EventHandler = {
            // We will accept pen down, mouse left down, or touch down as the start of a stroke.
            handlePointerDown : function(evt) {
                try {
                    checkForClear();
                    if (evt.button === 0) {
                        // Clear any current selection.
                        var pt = { x: 0.0, y: 0.0 };
                        self.inkManager.selectWithLine(pt, pt);

                        pt = evt.currentPoint;

                        if (pt.properties.isEraser) // the back side of a pen, which we treat as an eraser
                        {
                            tempEraseMode();
                        }
                        else {
                            restoreMode();
                        }

                        self.context.beginPath();
                        self.context.moveTo(pt.rawPosition.x, pt.rawPosition.y);

                        self.inkManager.processPointerDown(pt);
                        self.penID = evt.pointerId;
                    }
                }
                catch (e) {
                    self.onError(e);
                }
            },

            handlePointerMove : function(evt) {
                try {
                    if (evt.pointerId === self.penID) {
                        var pt = evt.currentPoint;
                        self.context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        self.context.stroke();
                        // Get all the points we missed and feed them to inkManager.
                        // The array pts has the oldest point in position length-1; the most recent point is in position 0.
                        // Actually, the point in position 0 is the same as the point in pt above (returned by evt.currentPoint).
                        var pts = evt.intermediatePoints;
                        for (var i = pts.length - 1; i >= 0 ; i--) {
                            self.inkManager.processPointerUpdate(pts[i]);
                        }
                    }
                }
                catch (e) {
                    self.onError(e);
                }
            },

            handlePointerUp : function(evt) {
                try {
                    if (evt.pointerId === self.penID) {
                        self.penID = -1;
                        var pt = evt.currentPoint;
                        self.context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        self.context.stroke();
                        self.context.closePath();

                        self.inkManager.processPointerUp(pt);

                        renderAllStrokes();
                    }
                }
                catch (e) {
                    self.onError(e);
                }
            },

            // We treat the event of the pen leaving the canvas as the same as the pen lifting;
            // it completes the stroke.
            handlePointerOut : function(evt) {
                try {
                    if (evt.pointerId === self.penID) {
                        var pt = evt.currentPoint;
                        self.context.lineTo(pt.rawPosition.x, pt.rawPosition.y);
                        self.context.stroke();
                        self.context.closePath();
                        self.inkManager.processPointerUp(pt);
                        self.penID = -1;
                        renderAllStrokes();
                    }
                }
                catch (e) {
                    self.onError(e);
                }
            }
        };

        // Redraws (from the beginning) all strokes in the canvases.  All canvases are erased,
        // then the paper is drawn, then all the strokes are drawn.
        function renderAllStrokes(dontFind)
        {
            self.inkContext.clearRect(0, 0, self.inkCanvas.width, self.inkCanvas.height);

            self.inkManager.getStrokes().forEach(function (stroke)
            {
                var att = stroke.drawingAttributes;
                var color = toColorString(att.color);
                var strokeSize = att.size;
                var width = strokeSize.width;
                if (stroke.selected)
                {
                    renderStroke(stroke, color, width * 2, self.inkContext);
                    var stripe = "White";
                    var w = width - 1;
                    renderStroke(stroke, stripe, w, self.inkContext);
                }
                else
                {
                    renderStroke(stroke, color, width, self.inkContext);
                }
            });

            if (!dontFind) {
                find();
            }
        }

        //Draws a single stroke into a specified canvas 2D context, with a specified color and width.
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
                self.onError(e);
            }
        }

        // Makes all strokes a part of the selection.
        function selectAllStrokes()
        {
            self.inkManager.getStrokes().forEach(function (stroke) {
                stroke.selected = true;
            });
        }

        self.clear = function()
        {
            try
            {
                selectAllStrokes();
                self.inkManager.deleteSelected();
                self.inkMode();

                renderAllStrokes(true);
            }
            catch (e)
            {
                self.onError(e);
            }
        };

        function checkForClear() {
            if (self.queuedClear) {
                window.clearTimeout(self.queuedClear);
                self.queuedClear = null;
            }
        }

        //TODO: update documentation

        // A handler for the Find button in the Find flyout.  We fetch the search string
        // from the form, and the array of recognition results objects from the ink
        // manager.  We unselect any current selection, so that when we are done
        // the selections will reflect the search results.  We split the search string into
        // individual words, since our recognition results objects each represent individual
        // words.  The actual matching is done by findWord(), defined above.

        // Note that multiple instances of a target can be found; if the target is "this" and
        // the ink contains "this is this is that", 2 instances of "this" will be found and all
        // strokes in both words will be selected.

        // Note that findWord() above searches all alternates.  This means you might write
        // "this", have it mis-recognized as "these", but the search feature MAY find it, if
        // "this" appears in any of the other 4 recognition alternates for this ink.
        function find() {
            try {
                checkForClear();
                self.inkManager.recognizeAsync(Windows.UI.Input.Inking.InkRecognitionTarget.all).done
                (
                    function (results) {
                        var i, valid;
                        self.inkManager.updateRecognitionResults(results);


                        if (self.conversionDictionary) {
                            valid = checkForValidRecognitionResults(results);
                            if (valid) {
                                if (self.handwritingRecognitionCallback && !self.handwritingRecognitionCallback(valid)) {
                                    //means there is a callback and the callback rejected the input
                                    //so we should clear the canvas immediately
                                    self.clear();
                                    checkForClear();
                                }
                                self.sendNotification("Found valid conversion: " + valid);
                            } else {
                                //give them 1 seconds to make it valid or clear the input
                                if (self.queuedClear) {
                                    clearTimeout();
                                }
                                self.queuedClear = window.setTimeout(self.clear, 1000);
                            }
                        } else {
                            for (i = 0; i < results.length; i++) {
                                self.sendNotification("Results: " + results[i].getTextCandidates().join());
                            }
                        }
                    },
                    function (e) {
                        self.onError(e);
                    }
                );
            }
            catch (e) {
                self.onError(e);
            }
            return false;
        }

        function checkForValidRecognitionResults(recognitionResults) {
            var i, j, key, m, textCandidates;
            for (i = 0; i < recognitionResults.length; i++) {
                textCandidates = recognitionResults[i].getTextCandidates();
                for (j = 0; j < textCandidates.length; j++) {
                    for (key in self.conversionDictionary) {
                        for (m = 0; m < self.conversionDictionary[key].length; m++) {
                            if (textCandidates[j] == self.conversionDictionary[key][m]) {
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
        self.setRecognizerByName = function (recname)
        {
            try
            {
                // recognizers is a normal JavaScript array
                var recognizers = self.inkManager.getRecognizers();
                for (var i = 0, len = recognizers.length; i < len; i++)
                {
                    if (recname === recognizers[i].name)
                    {
                        self.inkManager.setDefaultRecognizer(recognizers[i]);
                        return true;
                    }
                }
            }
            catch (e)
            {
                self.onError(e);
            }
            return false;
        };

        return self;
    };

    //elementId is the ID of the element that the canvas should be initialized in
    //(optional) configuration is an object with the following properties:
    //  errorHandler is a function that accepts an exception as the only argument
    //  messageHandler is a function that accepts a string as the only argument
    //  alphabetDictionary defines the language that should be accepted as input by handwriting recognition
    //      the dictionary should have chars for keys and lists of chars as values.
    //      if any char in the value list is detected by handwriting recognition InkCanvas will accept the key char as input
    //  recognitionCallback is a function that accepts a string for when handwriting has been recognized as valid input
    global.InkCanvas.prototype.initializeInk = function (elementId, configuration) {
        var self = this;
        // Utility to fetch elements by ID.
        function id(elementId) {
            return document.getElementById(elementId);
        }

        if (configuration) {
            if (configuration.errorHandler) {
                self.onError = configuration.errorHandler;
            }
            if (configuration.messageHandler) {
                self.sendNotification = configuration.messageHandler;
            }

            self.conversionDictionary = configuration.alphabetDictionary;

            self.handwritingRecognitionCallback = configuration.recognitionCallback;
        }

        WinJS.UI.processAll().then(
            function () {
                var parent = id(elementId);
                var canvasElement = document.createElement("canvas");
                parent.appendChild(canvasElement);

                self.inkCanvas = canvasElement;
                self.inkCanvas.gestureObject = new global.MSGesture();
                self.inkCanvas.gestureObject.target = self.inkCanvas;
                self.inkCanvas.setAttribute("width", self.inkCanvas.offsetWidth);
                self.inkCanvas.setAttribute("height", self.inkCanvas.offsetHeight);
                self.inkCanvas.style.backgroundColor = "White";
                self.inkContext = self.inkCanvas.getContext("2d");
                self.inkContext.lineWidth = 2;
                self.inkContext.strokeStyle = "Black";
                self.inkContext.lineCap = "round";
                self.inkContext.lineJoin = "round";

                self.inkCanvas.addEventListener("pointerdown", self.EventHandler.handlePointerDown, false);
                self.inkCanvas.addEventListener("pointerup", self.EventHandler.handlePointerUp, false);
                self.inkCanvas.addEventListener("pointermove", self.EventHandler.handlePointerMove, false);
                self.inkCanvas.addEventListener("pointerout", self.EventHandler.handlePointerOut, false);
                self.inkCanvas.addEventListener("MSGestureStart", self.EventHandler.handlePointerDown, false);
                self.inkCanvas.addEventListener("MSGestureEnd", self.EventHandler.handlePointerUp, false);

                if (!self.setRecognizerByName("Microsoft English (US) Handwriting Recognizer")) {
                    self.sendNotification("Failed to find English (US) recognizer");
                }

                self.inkMode();
            }
        ).done(
            function () {
            },
            function (e) {
                self.onError(e);
            }
        );
    };
}(window, Windows, WinJS));