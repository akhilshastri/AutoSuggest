import {
    data, cloneStyle,
    getGlobalOffset,
    getCursorPosition,
    getScrollLeftForInput,
    makeAsyncQueueRunner,
    getContainerTextNode,
    getComputedStyle
} from './Utilities';

import SuggestionList from './SuggestionList';
import SuggestionDropdown from './SuggestionDropdown';

function splitValue(originalValue, cursorPosition, trigger) {
    const value = originalValue.slice(0, cursorPosition);
    let textAfterTrigger = value.split(trigger || /\W/).pop();
    const textUptoTrigger = textAfterTrigger.length ? value.slice(0, 0 - textAfterTrigger.length) : value;
    textAfterTrigger += originalValue.slice(cursorPosition);
    return { textAfterTrigger, textUptoTrigger };
}

// Invisible character
const POSITIONER_CHARACTER = "\ufeff";
function getCaretPosition(element, trigger) {
    if (data(element, 'isInput')) {
        const cursorPosition = getCursorPosition(element);
        const { textAfterTrigger, textUptoTrigger } = splitValue(element.value, cursorPosition, trigger);

        // pre to retain special characters
        const clone = document.createElement('pre');
        clone.id = 'autosuggest-positionclone';

        const positioner = document.createElement('span');
        positioner.appendChild(document.createTextNode(POSITIONER_CHARACTER));

        clone.appendChild(document.createTextNode(textUptoTrigger.replace(/ /g, '\u00A0')));
        clone.appendChild(positioner);
        clone.appendChild(document.createTextNode(textAfterTrigger.replace(/ /g, '\u00A0')));
        cloneStyle(element, clone);

        const elementPosition = getGlobalOffset(element);
        clone.style.opacity = 0;
        clone.style.position = 'absolute';
        clone.style.top = `${elementPosition.top}px`;
        clone.style.left = `${elementPosition.left}px`;
        document.body.appendChild(clone);

        // Extra styles for the clone depending on type of input
        if (element.tagName === 'INPUT') {
            clone.style.overflowX = 'auto';
            clone.style.whiteSpace = 'nowrap';
            if (cursorPosition === element.value.length) {
                clone.scrollLeft = clone.scrollWidth - clone.clientWidth;
            } else {
                clone.scrollLeft = Math.min(getScrollLeftForInput(element), clone.scrollWidth - clone.clientWidth);
            }
        } else {
            clone.style.maxWidth = '100%';
            clone.style.whiteSpace = 'pre-wrap';
            clone.scrollTop = element.scrollTop;
            clone.scrollLeft = element.scrollLeft;
        }

        const caretPosition = getGlobalOffset(positioner);
        caretPosition.left -= clone.scrollLeft;

        const charHeight = parseFloat(getComputedStyle(positioner, 'line-height'));
        caretPosition.top += charHeight - clone.scrollTop;

        document.body.removeChild(clone);
        return caretPosition;
    } else {
        const { startContainer, startOffset, endContainer, endOffset } = window.getSelection().getRangeAt(0);
        const { cursorPosition, containerTextNode } = getContainerTextNode();
        const { textAfterTrigger, textUptoTrigger } = splitValue(containerTextNode.nodeValue, cursorPosition, trigger);

        const parentNode = containerTextNode.parentNode;
        const referenceNode = containerTextNode.nextSibling;

        const positioner = document.createElement("span");
        positioner.appendChild(document.createTextNode(POSITIONER_CHARACTER));
        parentNode.insertBefore(positioner, referenceNode);

        if (textAfterTrigger) {
            containerTextNode.nodeValue = textUptoTrigger;
            const remainingTextNode = document.createTextNode(textAfterTrigger);
            parentNode.insertBefore(remainingTextNode, referenceNode);
        }

        const caretPosition = getGlobalOffset(positioner);
        const charHeight = parseFloat(getComputedStyle(positioner, 'line-height'));
        caretPosition.top += charHeight;

        // Reset DOM to the state before changes
        parentNode.removeChild(positioner);
        if (textAfterTrigger) {
            parentNode.removeChild(containerTextNode.nextSibling);
            containerTextNode.nodeValue = textUptoTrigger + textAfterTrigger;
        }

        const selection = window.getSelection().getRangeAt(0);
        selection.setStart(startContainer, startOffset);
        selection.setEnd(endContainer, endOffset);

        return caretPosition;
    }
}

const getModifiedValue = (originalValue, insertText, cursorPosition, trigger) => {
    let value = originalValue.slice(0, cursorPosition);
    const currentValue = value.split(trigger || /\W/).pop();
    value = value.slice(0, 0 - currentValue.length - (trigger || '').length);
    return value + insertText + originalValue.slice(cursorPosition);
};

const getFocusPosition = (originalValue, modifiedValue, cursorPosition, focus) => {
    const cursorStartPosition = modifiedValue.length - (originalValue.length - cursorPosition);
    return [cursorStartPosition + focus[0], cursorStartPosition + focus[1]];
};

const setValue = ({ element, trigger, suggestion, onChange }) => {
    const insertText = suggestion.use;

    if (data(element, 'isInput')) {
        const cursorPosition = getCursorPosition(element);
        const originalValue = element.value;
        const modifiedValue = getModifiedValue(originalValue, insertText, cursorPosition, trigger);
        element.value = modifiedValue;
        element.focus();

        const focusPostion = getFocusPosition(originalValue, modifiedValue, cursorPosition, suggestion.focus);
        element.setSelectionRange(focusPostion[0], focusPostion[1]);
    } else {
        const { cursorPosition, containerTextNode } = getContainerTextNode();
        if (!containerTextNode) return null;

        const originalValue = containerTextNode.nodeValue;
        const modifiedValue = getModifiedValue(originalValue, insertText, cursorPosition, trigger);
        containerTextNode.nodeValue = modifiedValue;

        const focusPostion = getFocusPosition(originalValue, modifiedValue, cursorPosition, suggestion.focus);
        const selection = window.getSelection().getRangeAt(0);
        selection.setStart(containerTextNode, focusPostion[0]);
        selection.setEnd(containerTextNode, focusPostion[1]);
    }

    onChange(suggestion.use, suggestion);
};

class AutoSuggest {
    constructor(options, ...inputs) {
        if (!options) {
            throw new Error(`AutoSuggest: Missing required parameter, options`);
        }

        this.inputs = [];
        this.dropdown = new SuggestionDropdown();
        this.onChange = options.onChange || Function.prototype;
        this.maxSuggestions = options.maxSuggestions || 10;

        // validate suggestions
        this.suggestionLists = options.suggestions || [];
        for (let i = 0; i < this.suggestionLists.length; i++) {
            let suggestionList = this.suggestionLists[i];
            if (!(suggestionList instanceof SuggestionList)) {
                if (suggestionList.constructor !== Object) {
                    suggestionList = { values: suggestionList };
                }

                if (!suggestionList.hasOwnProperty('caseSensitive') && options.hasOwnProperty('caseSensitive')) {
                    suggestionList.caseSensitive = options.caseSensitive;
                }

                this.suggestionLists[i] = new SuggestionList(suggestionList);
            }
        }

        events: {
            const self = this;
            let activeSuggestionList = null;
            let handledInKeyDown = false;

            this.onBlurHandler = function() {
                self.dropdown.hide();
            };

            this.onKeyDownHandler = function(e) {
                handledInKeyDown = false;
                if (self.dropdown.isActive) {
                    const preventDefaultAction = () => {
                        e.preventDefault();
                        handledInKeyDown = true;
                    };

                    if (e.keyCode === 13 || e.keyCode === 9) {
                        setValue({
                            element: this,
                            trigger: activeSuggestionList.trigger,
                            suggestion: self.dropdown.getValue(),
                            onChange: self.onChange
                        });
                        self.dropdown.hide();
                        return preventDefaultAction();
                    } else if (e.keyCode === 40) {
                        self.dropdown.selectNext();
                        return preventDefaultAction();
                    } else if (e.keyCode === 38) {
                        self.dropdown.selectPrev();
                        return preventDefaultAction();
                    } else if (e.keyCode === 27) {
                        self.dropdown.hide();
                        return preventDefaultAction();
                    }
                }
            };

            this.onKeyUpHandler = function(e) {
                if (handledInKeyDown) return;

                let value;
                if (data(this, 'isInput')) {
                    const cursorPosition = getCursorPosition(this);
                    if ((this.value.charAt(cursorPosition) || '').trim()) {
                        self.dropdown.hide();
                        return;
                    }

                    value = this.value.slice(0, cursorPosition);
                } else {
                    const { cursorPosition, containerTextNode } = getContainerTextNode();
                    if (!containerTextNode || (containerTextNode.nodeValue.charAt(cursorPosition) || '').trim()) {
                        self.dropdown.hide();
                        return;
                    }

                    value = containerTextNode.nodeValue.slice(0, cursorPosition);
                }

                handleDropdown: {
                    let i = 0, triggerMatchFound = false;
                    const execute = makeAsyncQueueRunner();

                    self.dropdown.empty();
                    for (let suggestionList of self.suggestionLists) {
                        if (suggestionList.regex.test(value)) {
                            triggerMatchFound = true;

                            (i => {
                                const match = suggestionList.getMatch(value);
                                suggestionList.getSuggestions(match, results => {
                                    execute(() => {
                                        if (self.dropdown.isEmpty) {
                                            if (results.length) {
                                                activeSuggestionList = suggestionList;
                                                self.dropdown.fill(
                                                    results.slice(0, self.maxSuggestions),
                                                    suggestion => {
                                                        setValue({
                                                            element: this,
                                                            trigger: suggestionList.trigger,
                                                            suggestion: suggestion,
                                                            onChange: self.onChange
                                                        });
                                                    }
                                                );

                                                self.dropdown.show(getCaretPosition(this, suggestionList.trigger));
                                            } else {
                                                self.dropdown.hide();
                                            }
                                        }
                                    }, i);
                                });
                            })(i++);
                        }
                    }

                    if (!triggerMatchFound) {
                        self.dropdown.hide();
                    }
                }
            };
        }

        // initialize events on inputs
        this.addInputs(...inputs);
    }

    addInputs(...args) {
        const inputs = Array.prototype.concat.apply([], args.map(d => d[0] ? Array.prototype.slice.call(d, 0) : d));

        inputs.forEach(input => {
            // validate element
            if (input.isContentEditable) {
                data(input, 'isInput', false)
            } else if (input.tagName === 'TEXTAREA' || (input.tagName === 'INPUT' && input.type === 'text')) {
                data(input, 'isInput', true)
            } else {
                throw new Error('AutoSuggest: Invalid input: only input[type = text], textarea and contenteditable elements are supported');
            }

            // init events
            input.addEventListener('blur', this.onBlurHandler);
            input.addEventListener('keyup', this.onKeyUpHandler);
            input.addEventListener('keydown', this.onKeyDownHandler, true);

            data(input, 'index', this.inputs.push(input) - 1);
        });
    }

    removeInputs(...args) {
        const inputs = Array.prototype.concat.apply([], args.map(d => d[0] ? Array.prototype.slice.call(d, 0) : d));

        inputs.forEach(input => {
            const index = data(input, 'index');
            if (!isNaN(index)) {
                this.inputs.splice(index, 1);

                // destroy events
                input.removeEventListener('blur', this.onBlurHandler);
                input.removeEventListener('keyup', this.onKeyUpHandler);
                input.removeEventListener('keydown', this.onKeyDownHandler, true);
            }
        });
    }

    destroy() {
        this.removeInputs(this.inputs);
    }
}

export default AutoSuggest;
