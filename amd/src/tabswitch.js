define(['core/ajax', 'core/notification', 'quizaccess_proctoring/proctoring', 'quizaccess_proctoring/screencapture'],
    function(Ajax, Notification, Proctoring, ScreenCapture) {

        // Single row per switch-away/return pair: blur and visibilitychange often both fire for
        // the same physical switch, so only the first one starts the pending window.
        let pendingStart = null;
        let pendingType = null;

        return {
            /**
             * Start listening for tab-switch / window-focus-loss events on the live attempt page.
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

                const startPending = (eventtype) => {
                    if (pendingStart !== null) {
                        // Already tracking a switch-away from another event source; ignore the
                        // duplicate so only one row gets logged per physical switch.
                        return;
                    }
                    pendingStart = Date.now();
                    pendingType = eventtype;
                };

                const resolvePending = () => {
                    if (pendingStart === null) {
                        return;
                    }
                    const starttime = Math.floor(pendingStart / 1000);
                    const duration = Math.max(0, Math.round((Date.now() - pendingStart) / 1000));
                    const eventtype = pendingType;
                    pendingStart = null;
                    pendingType = null;

                    const request = {
                        methodname: 'quizaccess_proctoring_log_tabswitch',
                        args: {
                            'courseid': props.courseid,
                            'quizid': props.quizid,
                            'attemptid': props.attemptid || 0,
                            'eventtype': eventtype,
                            'starttime': starttime,
                            'duration': duration,
                        }
                    };

                    Ajax.call([request])[0].done(function(res) {
                        const tabswitchid = res.tabswitchid;
                        Proctoring.captureNow('violation', tabswitchid);
                        ScreenCapture.captureNow('violation', tabswitchid);
                    }).fail(Notification.exception);
                };

                document.addEventListener('visibilitychange', function() {
                    if (document.visibilityState === 'hidden') {
                        startPending('visibilitychange');
                    } else {
                        resolvePending();
                    }
                });

                window.addEventListener('blur', function() {
                    startPending('blur');
                });

                window.addEventListener('focus', function() {
                    resolvePending();
                });

                return true;
            }
        };
    });
