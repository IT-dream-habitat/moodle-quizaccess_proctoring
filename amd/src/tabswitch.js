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
                        if (pendingStart === null) {
                            pendingStart = Date.now();
                        }
                        return;
                    }

                    if (pendingStart === null) {
                        return;
                    }
                    const starttime = Math.floor(pendingStart / 1000);
                    const duration = Math.max(0, Math.round((Date.now() - pendingStart) / 1000));
                    pendingStart = null;

                    const request = {
                        methodname: 'quizaccess_proctoring_log_tabswitch',
                        args: {
                            'courseid': props.courseid,
                            'quizid': props.quizid,
                            'attemptid': props.attemptid || 0,
                            'eventtype': 'visibilitychange',
                            'starttime': starttime,
                            'duration': duration,
                        }
                    };

                    Ajax.call([request])[0].done(function(res) {
                        const tabswitchid = res.tabswitchid;
                        Proctoring.captureNow('violation', tabswitchid);
                        ScreenCapture.captureNow('violation', tabswitchid);
                    }).fail(Notification.exception);
                });

                return true;
            }
        };
    });
