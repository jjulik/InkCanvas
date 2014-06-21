(function (global, Windows) {
    "use strict";

    global.InkCanvas = function() {
        var self = this;
        var notifications = Windows.UI.Notifications;

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
        self.selCanvas = null;
        self.selContext = null;

        self.toast = function (message) {
            var template = notifications.ToastTemplateType.toastText01;
            var toastXml = notifications.ToastNotificationManager.getTemplateContent(template);
            var toastTextElements = toastXml.getElementsByTagName("text");
            toastTextElements[0].appendChild(toastXml.createTextNode(message));
            var toastNode = toastXml.selectSingleNode("/toast");
            toastNode.setAttribute("duration", "long");
            //toastXml.selectSingleNode("/toast").setAttribute("launch", '{"type":"toast","param1":"12345","param2":"67890"}');

            var toast = new notifications.ToastNotification(toastXml);
            var toastNotifier = notifications.ToastNotificationManager.createToastNotifier();
            toastNotifier.show(toast);
        };

        // Returns true if any strokes inside the ink manager are selected; false otherwise.
        function anySelected() {
            var strokes = self.inkManager.getStrokes();
            var len = strokes.length;
            for (var i = 0; i < len; i++)
            {
                if (strokes[i].selected)
                {
                    return true;
                }
            }
            return false;
        }

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

        // This global variable holds a reference to the div that is imposed on top of selected ink.
        // It is used to register event handlers that allow the user to move around selected ink.
        self.selBox = null;

        // Hides the (transparent) div that is used to capture events for moving selected ink
        function anchorSelection() {
            // Make selBox of size 0 and move it to the top-left corner
            self.selBox.style.left = "0px";
            self.selBox.style.top = "0px";
            self.selBox.style.width = "0px";
            self.selBox.style.height = "0px";
        }

        // Places the (transparent) div that is used to capture events for moving selected ink.
        // The assumption is that rect is the bounding box of the selected ink.
        function detachSelection(rect) {
            // Move and resize selBox so that it perfectly overlaps with rect
            self.selBox.rect = rect;
            self.selBox.style.left = self.selBox.rect.x + "px";
            self.selBox.style.top = self.selBox.rect.y + "px";
            self.selBox.style.width = self.selBox.rect.width + "px";
            self.selBox.style.height = self.selBox.rect.height + "px";
        }

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
        self.savedCursor = null;
        self.savedMode = null;

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
                self.savedCursor = self.selCanvas.style.cursor;
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
                self.selCanvas.style.cursor = self.savedCursor;
                clearMode();
            }
        }

        // Five functions to switch back and forth between ink mode, highlight mode, select mode, and erase mode.
        // There is also a temp erase mode, which uses the saveMode()/restoreMode() functions to
        // return us to our previous mode when done erasing.  This is used for quick erasers using the back end
        // of the pen (for those pens that have that).
        // NOTE: The erase modes also attempt to set the mouse/pen cursor to the image of a chalkboard eraser
        // (stored in images/erase.cur), but as of this writing cursor switching is not working.

        self.inkMode = function()
        {
            clearMode();
            self.context = self.inkContext;
            self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.inking;
            setDefaults();
            self.selCanvas.style.cursor = "default";
        }

        function selectMode()
        {
            clearMode();
            self.selContext.strokeStyle = self.selPattern;
            self.context = self.selContext;
            self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.selecting;
            self.selCanvas.style.cursor = "default";
        }

        function eraseMode()
        {
            clearMode();
            self.selContext.strokeStyle = "rgba(255,255,255,0.0)";
            self.context = self.selContext;
            self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
            self.selCanvas.style.cursor = "url(images/erase.cur), auto";
        }

        function tempEraseMode()
        {
            saveMode();
            self.selContext.strokeStyle = "rgba(255,255,255,0.0)";
            self.context = self.selContext;
            self.inkManager.mode = self.inkManager.mode = Windows.UI.Input.Inking.InkManipulationMode.erasing;
            self.selCanvas.style.cursor = "url(images/erase.cur), auto";
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

        function id(elementId) {
            // Utility to fetch elements by ID.
            // <summary>Utility to fetch elements by ID</summary>
            // <param name="elementId" type="String">The id of the element.</param>
            return document.getElementById(elementId);
        }

        //Event handler region
        self.EventHandler = {
            // We will accept pen down or mouse left down as the start of a stroke.
            // We will accept touch down or mouse right down as the start of a touch.
            handlePointerDown : function(evt) {
                try {

                    if ((evt.pointerType === "pen") || ((evt.pointerType === "mouse") && (evt.button === 0))) {
                        // Anchor and clear any current selection.
                        anchorSelection();
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
                    else if (evt.pointerType === "touch") {
                        // Start the processing of events related to this pointer as part of a gesture.
                        // In this sample we are interested in MSGestureTap event, which we use to show alternates. See handleTap event handler. 
                        self.selCanvas.gestureObject.addPointer(evt.pointerId);
                    }
                }
                catch (e) {
                    self.toast("handlePointerDown " + e.toString());
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

                    // No need to process touch events - selCanvas.gestureObject takes care of them and triggers MSGesture* events.
                }
                catch (e) {
                    self.toast("handlePointerMove " + e.toString());
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

                        var rect = self.inkManager.processPointerUp(pt);
                        if (self.inkManager.mode === Windows.UI.Input.Inking.InkManipulationMode.selecting) {
                            detachSelection(rect);
                        }

                        renderAllStrokes();
                    }
                }
                catch (e) {
                    self.toast("handlePointerUp " + e.toString());
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
                    self.toast("handlePointerOut " + e.toString());
                }
            },

            handleTap : function(evt) {
                // Anchor and clear any current selection.
                if (anySelected()) {
                    anchorSelection();
                    var pt = { x: 0.0, y: 0.0 };
                    self.inkManager.selectWithLine(pt, pt);
                    renderAllStrokes();
                }
            },

            handleSelectionBoxPointerDown : function(evt)
            {
                // Start the processing of events related to this pointer as part of a gesture.
                // In this sample we are interested in MSGestureChange event, which we use to move selected ink.
                // See handleSelectionBoxGestureChange event handler.
                self.selBox.gestureObject.addPointer(evt.pointerId);
            },

            handleSelectionBoxGestureChange : function(evt)
            {
                // Move selection box
                self.selBox.rect.x += evt.translationX;
                self.selBox.rect.y += evt.translationY;
                self.selBox.style.left = self.selBox.rect.x + "px";
                self.selBox.style.top = self.selBox.rect.y + "px";

                // Move selected ink
                self.inkManager.moveSelected({x: evt.translationX, y: evt.translationY});

                renderAllStrokes();
            }
        };

        // Redraws (from the beginning) all strokes in the canvases.  All canvases are erased,
        // then the paper is drawn, then all the strokes are drawn.
        function renderAllStrokes()
        {
            self.selContext.clearRect(0, 0, self.selCanvas.width, self.selCanvas.height);
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

            find();
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
                self.toast("renderStroke " + e.toString());
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
                self.inkManager.recognizeAsync(Windows.UI.Input.Inking.InkRecognitionTarget.all).done
                (
                    function (results) {
                        self.inkManager.updateRecognitionResults(results);

                        self.toast("Results: " + results);
                    },
                    function (e) {
                        self.toast("InkManager::recognizeAsync: " + e.toString());
                    }
                );
            }
            catch (e) {
                self.toast("find: " + e.toString());
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
                self.toast("setRecognizerByName: " + e.toString());
            }
            return false;
        }

        return self;
    };

    global.InkCanvas.prototype.initializeInk = function () {
        var self = this;
        // Utility to fetch elements by ID.
        function id(elementId) {
            return document.getElementById(elementId);
        }

        WinJS.UI.processAll().then(
            function () {
                self.inkCanvas = id("InkCanvas");
                self.inkCanvas.setAttribute("width", self.inkCanvas.offsetWidth);
                self.inkCanvas.setAttribute("height", self.inkCanvas.offsetHeight);
                self.inkContext = self.inkCanvas.getContext("2d");
                self.inkContext.lineWidth = 2;
                self.inkContext.strokeStyle = "Black";
                self.inkContext.lineCap = "round";
                self.inkContext.lineJoin = "round";

                self.selCanvas = id("SelectCanvas");
                self.selCanvas.gestureObject = new MSGesture();
                self.selCanvas.gestureObject.target = self.selCanvas;
                self.selCanvas.setAttribute("width", self.selCanvas.offsetWidth);
                self.selCanvas.setAttribute("height", self.selCanvas.offsetHeight);
                self.selContext = self.selCanvas.getContext("2d");
                self.selContext.lineWidth = 1;
                self.selContext.strokeStyle = "Gold";
                self.selContext.lineCap = "round";
                self.selContext.lineJoin = "round";

                self.selBox = id("SelectionBox");
                self.selBox.addEventListener("pointerdown", self.EventHandler.handleSelectionBoxPointerDown, false);
                self.selBox.addEventListener("MSGestureChange", self.EventHandler.handleSelectionBoxGestureChange, false);
                self.selBox.gestureObject = new MSGesture();
                self.selBox.gestureObject.target = self.selBox;
                self.selBox.style.left = "0px";
                self.selBox.style.top = "0px";
                self.selBox.style.width = "0px";
                self.selBox.style.height = "0px";

                // Note that we must set the event listeners on the top-most canvas.

                self.selCanvas.addEventListener("pointerdown", self.EventHandler.handlePointerDown, false);
                self.selCanvas.addEventListener("pointerup", self.EventHandler.handlePointerUp, false);
                self.selCanvas.addEventListener("pointermove", self.EventHandler.handlePointerMove, false);
                self.selCanvas.addEventListener("pointerout", self.EventHandler.handlePointerOut, false);
                self.selCanvas.addEventListener("MSGestureTap", self.EventHandler.handleTap, false);

                //var image = new Image();
                //image.onload = function () { self.selContext.strokeStyle = self.selPattern = self.selContext.createPattern(image, "repeat"); };
                //image.src = "images/select.png";

                if (!self.setRecognizerByName("Microsoft English (US) Handwriting Recognizer")) {
                    self.toast("Failed to find English (US) recognizer");
                }

                self.inkMode();
            }
        ).done(
            function () {
            },
            function (e) {
                self.toast("inkInitialize " + e.toString());
            }
        );
    };



    
}(window, Windows));