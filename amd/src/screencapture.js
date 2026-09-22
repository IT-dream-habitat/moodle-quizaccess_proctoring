// Whether the student has an active screen-share stream. Screen capture is a soft
// requirement: declining or stopping the share must never block the quiz attempt.
let screenShareActive = false;
let activeTakeScreenshot = null;

define(['jquery', 'core/ajax', 'core/notification', 'core/str'],
    function($, Ajax, Notification, Str) {
        const loadStrings = async function() {
            const stringkeys = [
                {key: 'warning:sharescreenwarning', component: 'quizaccess_proctoring'},
                {key: 'info:screenshareallowed', component: 'quizaccess_proctoring'},
                {key: 'screenshareended', component: 'quizaccess_proctoring'},
                {key: 'wrong_during_taking_screencapture', component: 'quizaccess_proctoring'},
                {key: 'sharescreenbutton', component: 'quizaccess_proctoring'},
                {key: 'sharescreentitle', component: 'quizaccess_proctoring'},
                {key: 'sharescreeninstructions', component: 'quizaccess_proctoring'},
                {key: 'sharescreenskip', component: 'quizaccess_proctoring'},
            ];
            try {
                const strings = await Str.get_strings(stringkeys);
                return {
                    sharescreenwarning: strings[0],
                    screenshareallowed: strings[1],
                    screenshareended: strings[2],
                    wrongduringtakingscreencapture: strings[3],
                    sharescreenbutton: strings[4],
                    sharescreentitle: strings[5],
                    sharescreeninstructions: strings[6],
                    sharescreenskip: strings[7],
                };
            } catch (error) {
                Notification.exception(error);
                return {};
            }
        };

        return {
            /**
             * Start periodic screen capture on the live quiz attempt page.
             *
             * Screen capture is a soft requirement: if the student declines the browser's
             * screen-share prompt, or later stops sharing, the attempt continues unaffected.
             * The only effect is that periodic/violation screenshots stop being taken.
             *
             * @param {Object} props courseid, quizid (cmid), id (pre-created screenshotlogid),
             *   image_width, screenshotdelay (ms).
             * @return {Promise<boolean>}
             */
            async init(props) {
                const strings = await loadStrings();

                // Skip on the quiz summary/review pages, same as the webcam capture loop.
                if (document.getElementById("page-mod-quiz-summary") !== null &&
                    document.getElementById("page-mod-quiz-summary").innerHTML.length) {
                    return false;
                }
                if (document.getElementById("page-mod-quiz-review") !== null &&
                    document.getElementById("page-mod-quiz-review").innerHTML.length) {
                    return false;
                }

                if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
                    // Not supported in this browser/webview: treat exactly like a decline.
                    return false;
                }

                const width = props.image_width;
                const video = document.createElement('video');
                video.style.display = 'none';
                document.body.appendChild(video);
                const canvas = document.createElement('canvas');

                const takeScreenshot = async(captureorigin, tabswitchid) => {
                    if (!screenShareActive) {
                        return;
                    }
                    const height = video.videoHeight / (video.videoWidth / width) || (width / (16 / 9));
                    canvas.width = width;
                    canvas.height = height;
                    const context = canvas.getContext('2d');
                    context.drawImage(video, 0, 0, width, height);
                    const data = canvas.toDataURL('image/png');

                    const request = {
                        methodname: 'quizaccess_proctoring_send_screenshot',
                        args: {
                            'courseid': props.courseid,
                            'screenshotlogid': props.id,
                            'quizid': props.quizid,
                            'screenshotpicture': data,
                            'captureorigin': captureorigin || 'interval',
                            'tabswitchid': tabswitchid || 0,
                        }
                    };

                    Ajax.call([request])[0].done(function(res) {
                        if (res.warnings.length >= 1) {
                            Notification.addNotification({
                                message: strings.wrongduringtakingscreencapture,
                                type: 'error'
                            });
                        }
                    }).fail(Notification.exception);
                };
                activeTakeScreenshot = takeScreenshot;

                let intervalhandle = null;

                const requestShare = async function() {
                    try {
                        // displaySurface: 'monitor' hints the browser to default the picker
                        // towards "Entire Screen" rather than a single window/tab - it's only
                        // a preference the browser may use for its default selection, never a
                        // guarantee, since the human always keeps the final choice.
                        const stream = await navigator.mediaDevices.getDisplayMedia({
                            video: {displaySurface: 'monitor'}
                        });
                        video.srcObject = stream;
                        await video.play();
                        screenShareActive = true;

                        Notification.addNotification({
                            message: strings.screenshareallowed,
                            type: 'success'
                        });

                        stream.getVideoTracks()[0].addEventListener('ended', function() {
                            screenShareActive = false;
                            if (intervalhandle) {
                                clearInterval(intervalhandle);
                            }
                            Notification.addNotification({
                                message: strings.screenshareended,
                                type: 'warning'
                            });
                        });

                        setTimeout(takeScreenshot, 3000);
                        intervalhandle = setInterval(takeScreenshot, props.screenshotdelay);
                    } catch (error) {
                        // Declined, dismissed, or otherwise unavailable: soft requirement, do
                        // not block the attempt, just let the student know captures are off.
                        screenShareActive = false;
                        Notification.addNotification({
                            message: strings.sharescreenwarning,
                            type: 'warning'
                        });
                    }
                };

                // Each quiz question page is a full browser navigation in Moodle's default
                // multi-page layout, which kills the live screen-share stream - there is no
                // way to keep one MediaStream alive across a page load, and getDisplayMedia()
                // always needs a fresh user gesture, so re-requesting on every page is
                // unavoidable. What we CAN avoid is re-showing the full blocking overlay every
                // single page once the student has already seen it once this attempt - track
                // that in sessionStorage (survives navigation, scoped to this attempt/tab) and
                // fall back to a small, unobtrusive corner button on later pages instead.
                const storagekey = 'quizaccess_proctoring_screenshare_seen_' + (props.attemptid || 0);
                let alreadyseen = false;
                try {
                    alreadyseen = sessionStorage.getItem(storagekey) === '1';
                } catch (error) {
                    alreadyseen = false;
                }
                const markseen = function() {
                    try {
                        sessionStorage.setItem(storagekey, '1');
                    } catch (error) {
                        // Storage unavailable (private browsing etc.) - just re-prompt fully
                        // next page, no worse than before this change.
                    }
                };

                if (alreadyseen) {
                    const banner = document.createElement('div');
                    banner.className = 'proctoring-screenshare-resume';
                    const resumebutton = document.createElement('button');
                    resumebutton.type = 'button';
                    resumebutton.className = 'btn btn-primary btn-sm';
                    resumebutton.textContent = strings.sharescreenbutton;
                    banner.appendChild(resumebutton);
                    document.body.appendChild(banner);

                    resumebutton.addEventListener('click', async function() {
                        banner.remove();
                        await requestShare();
                    }, {once: true});
                } else {
                    // getDisplayMedia() requires a genuine, direct user gesture in every major
                    // browser - unlike getUserMedia(), it cannot be requested automatically
                    // when the page loads (browsers silently refuse it with no prompt at all).
                    // There is no way around that click, so make it as hard to miss as
                    // possible on this first page. A "skip" option is required so the soft
                    // requirement still holds - the student must always be able to continue
                    // their attempt even if they never grant screen sharing.
                    const overlay = document.createElement('div');
                    overlay.className = 'proctoring-screenshare-overlay';
                    overlay.innerHTML = `
                        <div class="proctoring-screenshare-dialog">
                            <h3>${strings.sharescreentitle}</h3>
                            <p>${strings.sharescreeninstructions}</p>
                            <button type="button" class="btn btn-primary proctoring-screenshare-share">
                                ${strings.sharescreenbutton}
                            </button>
                            <button type="button" class="btn btn-link proctoring-screenshare-skip">
                                ${strings.sharescreenskip}
                            </button>
                        </div>`;
                    document.body.appendChild(overlay);

                    overlay.querySelector('.proctoring-screenshare-skip').addEventListener('click', function() {
                        markseen();
                        overlay.remove();
                    }, {once: true});

                    overlay.querySelector('.proctoring-screenshare-share').addEventListener('click', async function() {
                        markseen();
                        overlay.remove();
                        await requestShare();
                    }, {once: true});
                }

                return true;
            },

            /**
             * Capture a single screenshot immediately, outside the normal interval loop.
             * A safe no-op if screen sharing was never granted or has since stopped.
             *
             * @param {string} captureorigin Either 'interval' or 'violation'.
             * @param {number} tabswitchid Linked quizaccess_proctoring_tabswitch_logs id.
             * @return {Promise}
             */
            captureNow(captureorigin, tabswitchid) {
                if (!screenShareActive || !activeTakeScreenshot) {
                    return Promise.resolve();
                }
                return activeTakeScreenshot(captureorigin, tabswitchid);
            }
        };
    });
