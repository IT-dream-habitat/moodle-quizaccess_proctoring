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
        let pendingTabswitchId = null;

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

                        Ajax.call([request])[0].done(function(res) {
                            pendingTabswitchId = res.tabswitchid;
                            Proctoring.captureNow('violation', pendingTabswitchId);
                            ScreenCapture.captureNow('violation', pendingTabswitchId);
                        }).fail(Notification.exception);
                        return;
                    }

                    // Returning to the tab: now the final duration is known, fill it in on the
                    // violation row already created (and already tagged to its captures) above.
                    if (pendingStart === null) {
                        return;
                    }
                    const duration = Math.max(0, Math.round((Date.now() - pendingStart) / 1000));
                    const tabswitchid = pendingTabswitchId;
                    pendingStart = null;
                    pendingTabswitchId = null;

                    if (!tabswitchid) {
                        return;
                    }
                    Ajax.call([{
                        methodname: 'quizaccess_proctoring_update_tabswitch_duration',
                        args: {'tabswitchid': tabswitchid, 'duration': duration}
                    }])[0].fail(Notification.exception);
                });

                return true;
            }
        };
    });
