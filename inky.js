/* global Windows */
/* global WinJS */
/* global Debug */
(function (window, Windows, WinJS, Debug) {
    "use strict";

    /* Version 1.0.0 */
    var Inky;

    /**
     * A library for creating canvases that can recognize handwriting and automatically convert to text.
     * 
     * @module Inky
     * @requires Windows
     * @requires WinJS
     * @requires Debug
     */
    window.Inky = window.Inky || {};

    Inky = window.Inky;

    /**
     * A canvas that supports handwriting recognition.
     *
     * @class AutoCanvas
     * @constructor
     */
    Inky.AutoCanvas = function() {
        var self = this;

        /**
         * Error handler. Can be overriden when the ink is initialized.
         *
         * @event onError
         * @private
         * @param {Error} ex The error that was thrown.
         */
        var onError = function (ex) {
            throw ex;
        };

        /**
         * Message handler for debugging info. Can be overriden when the ink is initialized.
         *
         * @event sendNotification
         * @private
         * @param {String} message The message being sent.
         */
        var sendNotification = function (message) {
            Debug.writeln(message);
        };

        // Variables representing the ink interface.
        // The usage of a global variable for drawingAttributes is not completely necessary,
        // just a convenience.  One could always re-fetch the current drawingAttributes
        // from the inkManager.

        /**
         * Represents the ink interface.
         *
         * @property inkCanvas
         * @private
         * @type Windows.UI.Input.Inking.InkManager
         */
        var inkManager = new Windows.UI.Input.Inking.InkManager();

        /**
         * Keeps track of the inkManager's ink drawing attributes.
         *
         * @property drawingAttributes
         * @private
         * @type Windows.UI.Input.Inking.InkDrawingAttributes
         */
        var drawingAttributes = new Windows.UI.Input.Inking.InkDrawingAttributes();
        drawingAttributes.fitToCurve = true;
        inkManager.setDefaultDrawingAttributes(drawingAttributes);

        /**
         * A reference to the canvas element.
         *
         * @property inkCanvas
         * @private
         * @type HTMLElement
         */
        var inkCanvas = null;

        /**
         * 2D ink context.
         *
         * @property inkContext
         * @private
         * @type CanvasRenderingContext2D
         */
        var inkContext = null;

        /**
         * Global memory of the current pointID (for pen, and, separately, for touch).
         * We ignore handlePointerMove() and handlePointerUp() calls that don't use the same
         * pointID as the most recent handlePointerDown() call.  This is because the user sometimes
         * accidentally nudges the mouse while inking or touching.  This can cause move events
         * for that mouse that have different x,y coordinates than the ink trace or touch path
         * we are currently handling.
         * pointer* events maintain this pointId so that one can track individual fingers,
         * the pen, and the mouse.
         *
         * @property penID
         * @private
         * @type Number
         */
        var penID = -1;

        /**
         * The "mode" of whether we are inking or erasing is controlled by this variable,
         * which should be pointing to inkContext.
         *
         * @property context
         * @private
         * @type CanvasRenderingContext2D
         */
        var context = null;

        // Note that we can get into erasing mode in one of two ways: there is a eraser button in the toolbar,
        // and some pens have an active back end that is meant to represent erasing.  If we get into erasing
        // mode via the button, we stay in that mode until another button is pushed.  If we get into erasing
        // mode via the eraser end of the stylus, we should switch out of it when the user switches to the ink
        // end of the stylus.  And we want to return to the mode we were in before this happened.  Thus we
        // maintain a shallow stack (depth 1) of "mode" info.

        /**
         * Saved 2D ink context.
         *
         * @property savedContext
         * @private
         * @type CanvasRenderingContext2D
         */
        var savedContext = null;

        /**
         * Saved color or style to use for strokes.
         *
         * @property savedStyle
         * @private
         * @type nsIVariant
         */
        var savedStyle = null;

        /**
         * Saved ink mode.
         *
         * @property savedMode
         * @private
         * @type Windows.UI.Input.Inking.InkManipulationMode
         */
        var savedMode = null;

        /**
         * List of objects that determine the valid input for handwriting recognition.
         * If any of the letters in the list is detected by handwriting recognition
         * it should accept the char key as input.
         * Otherwise it will notify a list of conversions every time handwriting recognition occurs via sendNotification().
         *
         * @property conversionDictionary
         * @private
         * @type Object
         */
        var conversionDictionary = null;

        /**
         * Numerical id of the clear timeout that is set on the window.
         * Keeps track of whether we have already called clear (clear is usually called on a timeout to give the user
         * more time to finish inking).
         *
         * @property queuedClear
         * @private
         * @type Number
         */
        var queuedClear = null;

        /**
         * This is how long in milliseconds we should wait before clearing invalid input.
         * The default value for clearTimeout is 1000 ms.
         * This can be overridden by the configuration in initializeInk().
         *
         * @property clearTimeoutDuration
         * @private
         * @type Number
         */
        var clearTimeoutDuration = 1000;

        //handwritingRecognitionCallback depends upon conversionDictionary being set for it to work

        /**
         * This is an optional callback the user can send in when initializing ink.
         * It is called with the string that was recognized whenever valid handwriting is recognized.
         * If the callback is not null it will expect a true or false return value.
         * The return value decides whether the string should be accepted as input.
         * If false the handwriting will be cleared.
         *
         * @event handwritingRecognitionCallback
         * @private
         * @param {String} recognizedText The text that was recognized.
         */
        var handwritingRecognitionCallback = null;

        /**
         * Controls whether the canvas is currently accepting user input (pen, mouse, touch).
         *
         * @property canvasEnabled
         * @private
         * @type Boolean
         */
        var canvasEnabled = true;

        /**
         * Controls whether handwriting should automatically be converted to text.
         * When handwriting is recognized as valid input, the canvas will be cleared, disabled
         * and covered by an overlay that contains the text that was recognized.
         *
         * @property autoConvertHandwritingToText
         * @private
         * @type Boolean
         */
        var autoConvertHandwritingToText = false;

        /**
         * A reference to the element that contains the text to display if autoConvertHandwritingToText is enabled.
         *
         * @property textOverlayElement
         * @private
         * @type HTMLElement
         */
        var textOverlayElement;

        // Functions to convert from and to the 32-bit int used to represent color in Windows.UI.Input.Inking.InkManager.

        /**
         * Converts an integer to its 2-digit string hexideciaml representation. Assumes arg num is a number (0..255).
         *
         * @method toColorString
         * @private
         * @param {Number} num Integer to convert.
         * @return {String} Converted hex string.
         */
        function byteHex(num)
        {
            var hex = num.toString(16);
            if (hex.length === 1)
            {
                hex = "0" + hex;
            }
            return hex;
        }

        /**
         * Convert from Windows.UI.Color to html's color hex string.
         *
         * @method toColorString
         * @private
         * @param {Windows.UI.Color} color Color object to convert.
         * @return {String} Converted color hex string.
         */
        function toColorString(color)
        {
            return "#" + byteHex(color.r) + byteHex(color.g) + byteHex(color.b);
        }

        /**
         * Convert from the few color names used in this library to Windows.UI.Input.Inking's color code.
         * If it isn't one of those, then decode the hex string.  Otherwise return gray.
         * The alpha component is always set to full (255).
         *
         * @method toColorStruct
         * @private
         * @param {String} color Name of the color. Ex: "Black", "Blue", "Red"
         * @return {Windows.UI.Color} Converted color.
         */
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

        /**
         * Clear the current ink mode.
         *
         * @method clearMode
         * @private
         */
        function clearMode() {
            savedContext = null;
            savedStyle = null;
            savedMode = null;
        }

        /**
         * Save the current ink mode.
         *
         * @method saveMode
         * @private
         */
        function saveMode() {
            if (!savedContext) {
                savedStyle = context.strokeStyle;
                savedContext = context;
                savedMode = inkManager.mode;
            }
        }

        /**
         * Restore the saved ink mode.
         *
         * @method restoreMode
         * @private
         */
        function restoreMode() {
            if (savedContext) {
                context = savedContext;
                context.strokeStyle = savedStyle;
                inkManager.mode = savedMode;
                clearMode();
            }
        }

        /**
         * Sets the ink mode to inking (default).
         *
         * @method inkMode
         * @private
         */
        function inkMode()
        {
            clearMode();
            context = inkContext;
            inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
            setDefaults();
        }

        /**
         * Change the ink mode to erase for erasers on the back of pens (like the Surface Pro 1 & 2).
         * Uses the saveMode()/restoreMode() functions to return us to our previous mode when done erasing.
         *
         * @method tempEraseMode
         * @private
         */
        function tempEraseMode()
        {
            saveMode();
            inkContext.strokeStyle = "rgba(255,255,255,0.0)";
            context = inkContext;
            inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
        }

        /**
         * Change the color and width in the default (used for new strokes) to the values currently set in the current context.
         * Note that we cannot just set the width in stroke.drawingAttributes.size.width,
         * or the color in stroke.drawingAttributes.color.
         * The stroke API supports get and put operations for drawingAttributes,
         * but we must execute those operations separately, and change any values
         * inside drawingAttributes between those operations.
         *
         * @method setDefaults
         * @private
         */
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
            /**
             * Fired on pen down, mouse left down, and touch down.
             * Signals the start of a stroke.
             *
             * @event EventHandler.handlePointerDown
             * @private
             * @param {PointerEvent} evt The pointer down event.
             */
            handlePointerDown : function(evt) {
                try {
                    if (!canvasEnabled) {
                        return false;
                    }
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

            /**
             * Fired when the pen, mouse, or finger moves.
             *
             * @event EventHandler.handlePointerMove
             * @private
             * @param {PointerEvent} evt The pointer move event.
             */
            handlePointerMove : function(evt) {
                try {
                    if (!canvasEnabled) {
                        return false;
                    }
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

            /**
             * Fired when the pen, mouse, or finger lifts off the canvas.
             *
             * @event EventHandler.handlePointerUp
             * @private
             * @param {PointerEvent} evt The pointer up event.
             */
            handlePointerUp : function(evt) {
                try {
                    if (!canvasEnabled) {
                        return false;
                    }
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

            /**
             * Fired when the pen or mouse goes outside the canvas.
             * We treat the event of the pen leaving the canvas as the same as the pen lifting;
             * it completes the stroke.
             *
             * @event EventHandler.handlePointerOut
             * @private
             * @param {PointerEvent} evt The pointer out event.
             */
            handlePointerOut : function(evt) {
                try {
                    if (!canvasEnabled) {
                        return false;
                    }
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

        /**
         * Redraws (from the beginning) all strokes in the canvases.  All canvases are erased,
         * then the paper is drawn, then all the strokes are drawn.
         *
         * @method renderAllStrokes
         * @param {Boolean} [dontFind] Whether to not perform handwriting recognition after rendering the strokes.
         * @private
         */
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

        /**
         * Draws a single stroke into a specified canvas 2D context, with a specified color and width.
         *
         * @method renderStroke
         * @param {InkStroke} stroke The stroke to draw.
         * @param {nsIVariant} color Color or style to use for stroke lines. Default #000 (black).
         * @param {float} width The width of the stroke.
         * @param {CanvasRenderingContext2D} ctx The 2D context to draw the stroke on.
         * @private
         */
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

        /**
         * Makes all strokes a part of the selection.
         *
         * @method selectAllStrokes
         * @private
         */
        function selectAllStrokes()
        {
            inkManager.getStrokes().forEach(function (stroke) {
                stroke.selected = true;
            });
        }

        /**
         * Prevents any queued calls to clear from happening then empties the queue.
         *
         * @method resetClearQueue
         * @private
         */
        function resetClearQueue() {
            if (queuedClear) {
                window.clearTimeout(queuedClear);
                queuedClear = null;
            }
        }

        /**
         * Calls asynchronous handwriting recognition, which returns a list of results.
         * Each result has a list of potential text candidates.
         * We use the conversion dictionary to check against all potential text candidates to see if we have valid input.
         * If the handwriting is recognized as valid input we call handwritingRecognitionCallback.
         *
         * @method find
         * @private
         */
        function find() {
            try {
                resetClearQueue();
                inkManager.recognizeAsync(Windows.UI.Input.Inking.InkRecognitionTarget.all).done
                (
                    function (results) {
                        var i, recognizedText;
                        inkManager.updateRecognitionResults(results);


                        if (conversionDictionary) {
                            recognizedText = checkForValidRecognitionResults(results);
                            if (recognizedText) {
                                // Call the handwriting recognition callback
                                if (handwritingRecognitionCallback && !handwritingRecognitionCallback(recognizedText)) {
                                    // Means there is a callback and the callback rejected the input
                                    // so we should clear the canvas immediately
                                    self.clear();
                                    resetClearQueue();
                                    return false;
                                }
                                // Check to see if we should automatically convert the handwriting to text
                                if (autoConvertHandwritingToText) {
                                    displayTextOverlay(recognizedText);
                                    canvasEnabled = false;
                                    self.clear();
                                }

                                sendNotification("Found valid conversion: " + recognizedText);
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

        /**
         * Checks the handwriting recognition results for valid input according to the conversion dictionary.
         * If any valid input is found, the appropriate key from the conversion dictionary is returned.
         *
         * @method checkForValidRecognitionResults
         * @private
         * @param {IVectorView<InkRecognitionResult>} recognitionResults The text candidates returned by handwriting recognition.
         * @return {String} The text that was recognized.
         */
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
            return null;
        }

        /**
         * Displays text over the canvas. This also disables the canvas.
         *
         * @method displayTextOverlay
         * @private
         * @param {String} text The text to display.
         */
        function displayTextOverlay(text) {
            textOverlayElement.innerText = text;
            textOverlayElement.style.zIndex = "6"; 
        }

        /**
         * Hides the text overlay that displays converted handwriting.
         *
         * @method hideTextOverlay
         * @private
         */
        function hideTextOverlay() {
            textOverlayElement.style.zIndex = "4";
        }

        /**
         * Finds a specific recognizer, and sets the inkManager's default to that recognizer.
         *
         * @method setRecognizerByName
         * @private
         * @param {String} recname The name of the InkManager recognizer.
         * @return {Boolean} Whether it found the recognizer specified by recname.
         */
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

        // Publicly Accessible functions go down here

        /**
         * Clears the canvas of all strokes.
         *
         * @method clear
         */
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

        /**
         * Sets whether the canvas is enabled.
         *
         * @method setCanvasEnabled
         * @param {Boolean} value Whether the canvas should be enabled (allow pen, mouse, and touch inout from the user).
         */
        self.setCanvasEnabled = function(value) {
            canvasEnabled = value;
        };

        /**
         * Returns whether the canvas is enabled.
         *
         * @method getCanvasEnabled
         * @return {Boolean} Whether the canvas is enabled.
         */
        self.getCanvasEnabled = function() {
            return canvasEnabled;
        };

        /**
         * Resets the canvas back to default inkable mode.
         *
         * @method resetCanvas
         */
        self.resetCanvas = function() {
            self.clear();
            self.setCanvasEnabled(true);
            hideTextOverlay();
        };

        /**
         * Creates a canvas DOM Element inside the Element with the specified elementId. The canvas begins responding
         * to pen, mouse, and touch input upon creation. Accepts a configuration Object containing various configuration properties.
         * Sample configuration:
         * <pre>
         * {
         *  errorHandler : function(ex) { throw ex; },
         *  messageHandler: function(message) { Debug.writeLn(message); },
         *  alphabetDictionary : [
         *      "X": ["x","X","%","T","t"],
         *      "O": ["o","O","0","Q"]
         *  ],
         *  recognitionCallback: function(value) { Debug.writeLn("Input recognized: " + value); },
         *  clearTimeoutDuration: 2000,
         *  autoConvertHandwritingToText: true,
         *  fontSize: "10rem"
         * }
         * </pre>
         *
         * @method initializeInk
         * @param {String} elementId A case-sensitive string representing the unique ID of the element to create a canvas inside of.
         * @param {Object} [configuration] An optional object containing several configuration parameters which affect the behaviour
         * of the canvas.
         * @param {Function} [configuration.errorHandler] A callback function to handle errors.
         * @param {Error} configuration.errorHandler.ex The Error object that will be passed into the errorHandler if an error occurs.
         * @param {Function} [configuration.messageHandler] A callback function for debugging messages.
         * @param {String} configuration.messageHandler.message The debug message that will be passed into messageHandler.
         * @param {Object} [configuration.alphabetDictionary] An object that defines the input that should be recognized by handwriting recognition.
         * @param {Function} [configuration.recognitionCallback] A callback function for when handwriting is recognized.
         * @param {String} configuration.recognitionCallback The text that was recognized to be passed into recognitionCallback.
         * @param {Number} [configuration.clearTimeoutDuration=1000] The length of time in milliseconds to wait for additional user input before clearing unrecognized handwriting from the canvas.
         * @param {Boolean} [configuration.autoConvertHandwritingToText=false] Determines if handwriting should automatically be converted to text as soon as it is recongized.
         * @param {String} [configuration.fontSize="4rem"] The CSS value for the font size of text in the canvas. 
         */
        self.initializeInk = function (elementId, configuration) {
            var fontSize = "4rem";

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

                if (configuration.autoConvertHandwritingToText) {
                    autoConvertHandwritingToText = configuration.autoConvertHandwritingToText;
                }

                if (configuration.fontSize) {
                    fontSize = configuration.fontSize;
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
                    inkCanvas.style.position = "relative";
                    inkCanvas.style.zIndex = "5";
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

                    textOverlayElement = document.createElement("div");
                    textOverlayElement.style.backgroundColor = "White";
                    textOverlayElement.style.color = "Black";
                    textOverlayElement.style.position = "absolute";
                    textOverlayElement.style.top = "0";
                    textOverlayElement.style.width = "100%";
                    textOverlayElement.style.height = "100%";
                    textOverlayElement.style.zIndex = "4";
                    textOverlayElement.style.textAlign = "center";
                    textOverlayElement.style.fontSize = fontSize;
                    textOverlayElement.style.lineHeight = inkCanvas.offsetHeight + "px";
                    parent.appendChild(textOverlayElement);

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