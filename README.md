# Inky
WinJS library for creating HTML elements that recognize handwriting and automatically convert to text.

Inky is compatible with Windows 8 and Universal Windows JavaScript applications.

## Usage
Add inky.js to your project. Include this file on any pages you want to use it. The following is some sample code on how to add an auto recognizing element to a page.

```javascript
var autoCanvas = new Inky.AutoCanvas();
var configuration = {
  errorHandler: function (ex) { console.log(ex.toString()); },
  // alphabetDictionary allows you to choose which characters should be recognized.
  // It also makes it possible to correct for recognition errors.
  alphabetDictionary: {
    "X": ["x", "X", "%", "T", "t"],
    "O": ["o", "O", "0", "Q"]
  },
  recognitionCallback: function (value) { 
    console.log("autoCanvas recognized the following character: " + value); 
  },
  autoConvertHandwritingToText: true,
  fontSize: "8rem"
};
// idOfElement is the id of the element your auto canvas should go inside. 
// It is not recommended to place 2 auto canvas's within the same element
autoCanvas.initializeInk('idOfElement', configuration);
```
