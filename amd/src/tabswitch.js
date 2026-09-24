define(['core/ajax', 'core/notification', 'quizaccess_proctoring/proctoring', 'quizaccess_proctoring/screencapture'],
    function(Ajax, Notification, Proctoring, ScreenCapture) {

        // Deliberately visibilitychange only, not window blur/focus. blur fires whenever the
        // browser window loses OS-level focus for ANY reason - a browser extension popup
        // (password manager, grammar checker), an OS notification, or various native dialogs
        // can all trigger it without the student actually leaving the exam tab, which produced
        // real false-positive violations in testing. visibilitychange only fires when the tab
        // itself is actually hidden (switched away from, or covered by another app), which is a
        // much more reliable "did they actually leave the exam" signal.
        let pendingStart = null;
        // Resolves to the server-assigned tabswitchid once log_tabswitch's AJAX round-trip
        // completes. A plain shared variable written from inside that async callback is not
        // safe here: if the student switches back to Moodle FASTER than the network round-trip
        // (a real, observed case), the 'visible' handler would run before the id was ever
        // assigned, silently losing the duration update. Chaining off this promise instead
        // works correctly regardless of which side (the switch-back, or the server response)
        // happens first.
        let pendingIdPromise = null;

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

                document.addEventListener('visibilitychange', function() {
                    if (document.visibilityState === 'hidden') {
                        if (pendingStart !== null) {
                            return;
                        }
                        pendingStart = Date.now();
                        const starttime = Math.floor(pendingStart / 1000);

                        // Log the violation - and capture evidence - immediately, while the
                        // student is actually away, not when they come back. A screen/webcam
                        // capture taken after they return just shows Moodle again, which is
                        // useless as evidence of what they switched to; the whole point is
                        // catching what was on screen at the moment of the switch (this only
                        // shows the other tab/app if the student granted "Entire Screen"
                        // sharing rather than a single window or tab).
                        const request = {
                            methodname: 'quizaccess_proctoring_log_tabswitch',
                            args: {
                                'courseid': props.courseid,
                                'quizid': props.quizid,
                                'attemptid': props.attemptid || 0,
                                'eventtype': 'visibilitychange',
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
                        return;
                    }

                    // Returning to the tab: now the final duration is known. The violation id
                    // may or may not have come back from the server yet - either way, capture
                    // the duration now (while it's accurate) and the promise itself (before
                    // clearing state), then apply the update once/whenever the id is ready.
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
                });

                return true;
            }
        };
    });
