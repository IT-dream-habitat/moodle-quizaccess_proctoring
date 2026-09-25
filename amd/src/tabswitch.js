define(['core/ajax', 'core/notification', 'quizaccess_proctoring/proctoring', 'quizaccess_proctoring/screencapture'],
    function(Ajax, Notification, Proctoring, ScreenCapture) {

        // How long the window must stay unfocused before a 'blur' counts as a real violation.
        // blur fires whenever the browser window loses OS-level focus for ANY reason - a browser
        // extension popup (password manager, grammar checker), an OS notification, or various
        // native dialogs can all trigger it and then resolve within a moment, without the
        // student actually leaving the exam - that produced real false-positive violations
        // before this threshold existed. A genuine switch to another tab/app lasts noticeably
        // longer than a passing popup, so waiting this long before counting it filters out the
        // transient triggers while still catching real ones - just a little slower to react.
        const BLUR_THRESHOLD_MS = 2000;

        let pendingStart = null;
        // Resolves to the server-assigned tabswitchid once log_tabswitch's AJAX round-trip
        // completes. A plain shared variable written from inside that async callback is not
        // safe here: if the student switches back to Moodle FASTER than the network round-trip
        // (a real, observed case), the 'visible'/'focus' handler would run before the id was
        // ever assigned, silently losing the duration update. Chaining off this promise instead
        // works correctly regardless of which side (the switch-back, or the server response)
        // happens first.
        let pendingIdPromise = null;
        let blurThresholdTimer = null;
        let blurStartTime = null;

        return {
            /**
             * Start listening for tab-switch events on the live attempt page.
             *
             * @param {Object} props courseid, quizid (cmid), attemptid.
             * @return {boolean}
             */
            init(props) {
                // Skip on the quiz summary/review pages, same as the webcam capture loop.
                if (document.getElementById("page-mod-quiz-summary") !== null &&
                    document.getElementById("page-mod-quiz-summary").innerHTML.length) {
                    return false;
                }
                if (document.getElementById("page-mod-quiz-review") !== null &&
                    document.getElementById("page-mod-quiz-review").innerHTML.length) {
                    return false;
                }

                /**
                 * Start tracking a switch-away, unless one is already in progress (from either
                 * visibilitychange or a blur that already passed its threshold).
                 *
                 * @param {string} eventtype 'visibilitychange' or 'blur'.
                 * @param {number} starttimeMs Date.now() value when the switch actually began.
                 */
                function startCycle(eventtype, starttimeMs) {
                    if (pendingStart !== null) {
                        return;
                    }
                    pendingStart = starttimeMs;
                    const starttime = Math.floor(starttimeMs / 1000);

                    // Log the violation - and capture evidence - immediately, while the student
                    // is actually away, not when they come back. A screen/webcam capture taken
                    // after they return just shows Moodle again, which is useless as evidence of
                    // what they switched to; the whole point is catching what was on screen at
                    // the moment of the switch (this only shows the other tab/app if the student
                    // granted "Entire Screen" sharing rather than a single window or tab).
                    const request = {
                        methodname: 'quizaccess_proctoring_log_tabswitch',
                        args: {
                            'courseid': props.courseid,
                            'quizid': props.quizid,
                            'attemptid': props.attemptid || 0,
                            'eventtype': eventtype,
                            'starttime': starttime,
                            'duration': 0,
                        }
                    };

                    pendingIdPromise = new Promise(function(resolve) {
                        Ajax.call([request])[0].done(function(res) {
                            const tabswitchid = res.tabswitchid;
                            Proctoring.captureNow('violation', tabswitchid);
                            ScreenCapture.captureNow('violation', tabswitchid);
                            resolve(tabswitchid);
                        }).fail(function(error) {
                            Notification.exception(error);
                            resolve(null);
                        });
                    });
                }

                /**
                 * Returning to the tab: now the final duration is known. The violation id may or
                 * may not have come back from the server yet - either way, capture the duration
                 * now (while it's accurate) and the promise itself (before clearing state), then
                 * apply the update once/whenever the id is ready.
                 */
                function resolveCycle() {
                    if (pendingStart === null) {
                        return;
                    }
                    const duration = Math.max(0, Math.round((Date.now() - pendingStart) / 1000));
                    const idPromise = pendingIdPromise;
                    pendingStart = null;
                    pendingIdPromise = null;

                    if (!idPromise) {
                        return;
                    }
                    idPromise.then(function(tabswitchid) {
                        if (!tabswitchid) {
                            return;
                        }
                        Ajax.call([{
                            methodname: 'quizaccess_proctoring_update_tabswitch_duration',
                            args: {'tabswitchid': tabswitchid, 'duration': duration}
                        }])[0].fail(Notification.exception);
                    });
                }

                document.addEventListener('visibilitychange', function() {
                    if (document.visibilityState === 'hidden') {
                        // A real tab-hide always wins over a same-tab blur guess in progress.
                        if (blurThresholdTimer !== null) {
                            clearTimeout(blurThresholdTimer);
                            blurThresholdTimer = null;
                        }
                        startCycle('visibilitychange', Date.now());
                    } else {
                        resolveCycle();
                    }
                });

                window.addEventListener('blur', function() {
                    // Already tracking this switch via visibilitychange, or an earlier blur
                    // that already passed its threshold - nothing more to do here.
                    if (pendingStart !== null || blurThresholdTimer !== null) {
                        return;
                    }
                    blurStartTime = Date.now();
                    blurThresholdTimer = setTimeout(function() {
                        blurThresholdTimer = null;
                        startCycle('blur', blurStartTime);
                    }, BLUR_THRESHOLD_MS);
                });

                window.addEventListener('focus', function() {
                    if (blurThresholdTimer !== null) {
                        // Refocused before the threshold elapsed: a transient trigger (extension
                        // popup, notification, native dialog), not a genuine switch away.
                        // Discard it entirely - no row, no capture, nothing logged.
                        clearTimeout(blurThresholdTimer);
                        blurThresholdTimer = null;
                        blurStartTime = null;
                        return;
                    }
                    resolveCycle();
                });

                return true;
            }
        };
    });
