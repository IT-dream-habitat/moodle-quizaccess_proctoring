<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

defined('MOODLE_INTERNAL') || die;

require_once($CFG->libdir.'/externallib.php');
require_once($CFG->dirroot.'/mod/quiz/accessrule/proctoring/lib.php');

/**
 * External API class for the Quiz Proctoring plugin.
 *
 * This class provides external functions for the `quizaccess_proctoring` plugin,
 * allowing integration with Moodle’s web services.
 *
 * @package   quizaccess_proctoring
 * @category  external
 * @copyright 2024 Brain Station 23
 * @license   http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */
class quizaccess_proctoring_external extends external_api {

    /**
     * Defines the parameters required for sending a camshot.
     *
     * This function specifies the parameters that must be provided when calling
     * the send_camshot web service.
     *
     * @return external_function_parameters The required parameters:
     *      - 'courseid' (int): The ID of the course where the proctoring took place.
     *      - 'screenshotid' (int): The unique ID of the captured screenshot.
     *      - 'quizid' (int): The ID of the quiz associated with the screenshot.
     *      - 'webcampicture' (string): The base64-encoded webcam image or file path.
     *      - 'imagetype' (int): The type of image being stored.
     *      - 'parenttype' (string): The parent type associated with the face image.
     *      - 'faceimage' (string): The base64-encoded cropped face image or file path.
     *      - 'facefound' (int): A flag indicating whether a face was detected (1 = Yes, 0 = No).
     */
    public static function send_camshot_parameters() {
        return new external_function_parameters(
            [
                'courseid' => new external_value(PARAM_INT, 'course id'),
                'screenshotid' => new external_value(PARAM_INT, 'screenshot id'),
                'quizid' => new external_value(PARAM_INT, 'screenshot quiz id'),
                'webcampicture' => new external_value(PARAM_RAW, 'webcam photo'),
                'imagetype' => new external_value(PARAM_INT, 'image type'),
                'parenttype' => new external_value(PARAM_RAW, 'Face image parent type', VALUE_DEFAULT, ''),
                'faceimage' => new external_value(PARAM_RAW, 'Face Image', VALUE_DEFAULT, ''),
                'facefound' => new external_value(PARAM_INT, 'Face found flag', VALUE_DEFAULT, 0),
                'captureorigin' => new external_value(
                    PARAM_ALPHA, 'Whether this was an interval or violation capture', VALUE_DEFAULT, 'interval'),
                'tabswitchid' => new external_value(
                    PARAM_INT, 'Linked quizaccess_proctoring_tabswitch_logs id, 0 if none', VALUE_DEFAULT, 0),
            ]
        );
    }

    /**
     * Store the cam shots in Moodle subsystems and insert into the log table.
     *
     * This function processes webcam images and face images, storing them in Moodle's file storage system
     * and inserting records into the `quizaccess_proctoring_logs` and `quizaccess_proctoring_face_images` tables.
     * The images are saved and linked to the appropriate quiz and user. Additionally, metadata like face found
     * flag and parent type are saved.
     *
     * @param int $courseid The course ID where the proctoring took place.
     * @param int $screenshotid The ID of the screenshot being uploaded.
     * @param int $quizid The ID of the quiz associated with the screenshot (or CMID).
     * @param string $webcampicture The base64-encoded webcam image.
     * @param int $imagetype The type of image being uploaded (e.g., webcam photo or other).
     * @param string $parenttype The parent type, indicating whether the image is an Admin Image or Webcam Image.
     * @param string $faceimage The base64-encoded face image extracted from the webcam photo.
     * @param int $facefound A flag indicating whether a face was detected (1 = face found, 0 = face not found).
     *
     * @return array Returns an array with the following:
     *      - 'screenshotid' (int): The ID of the stored screenshot.
     *      - 'warnings' (array): A list of warnings generated during the process (if any).
     *
     * @throws dml_exception If there is a problem with database interaction.
     * @throws file_exception If there is an issue storing or retrieving files.
     * @throws invalid_parameter_exception If one or more parameters are invalid.
     * @throws stored_file_creation_exception If there is a problem creating or storing files.
     */
    public static function send_camshot(
        $courseid, $screenshotid, $quizid, $webcampicture, $imagetype, $parenttype = '', $faceimage = '',
        $facefound = 0, $captureorigin = 'interval', $tabswitchid = 0) {
        global $DB, $USER;

        // Validate the params.
        self::validate_parameters(
            self::send_camshot_parameters(),
            [
                'courseid' => $courseid,
                'screenshotid' => $screenshotid,
                'quizid' => $quizid,
                'webcampicture' => $webcampicture,
                'imagetype' => $imagetype,
                'parenttype' => $parenttype,
                'faceimage' => $faceimage,
                'facefound' => $facefound,
                'captureorigin' => $captureorigin,
                'tabswitchid' => $tabswitchid,
            ]
        );

        // Check if the user is enrolled in the course as a student or teacher.
        $context = context_course::instance($courseid);

        if (
            !is_enrolled($context, $USER->id, 'mod/quiz:attempt') && // Check student capability.
            !has_capability('mod/quiz:grade', $context)              // Check teacher capability.
        ) {
            throw new moodle_exception(
                'accessdenied', 'quizaccess_proctoring', '', null,
                get_string('notenrolled', 'quizaccess_proctoring')
            );
        }

        $warnings = [];

        if ($imagetype == 1) {
            $record = new stdClass();
            $record->filearea = 'picture';
            $record->component = 'quizaccess_proctoring';
            $record->filepath = '';
            $record->itemid = $screenshotid;
            $record->license = '';
            $record->author = '';

            $context = context_module::instance($quizid);
            $fs = get_file_storage();
            $record->filepath = file_correct_filepath($record->filepath);

            // For base64 to file.
            $data = $webcampicture;
            list(, $data) = explode(';', $data);
            $url = self::geturl($data, $screenshotid, $USER, $courseid, $record, $context, $fs);

            $camshot = $DB->get_record('quizaccess_proctoring_logs', ['id' => $screenshotid]);

            $record = new stdClass();
            $record->courseid = $courseid;
            $record->quizid = $quizid;
            $record->userid = $USER->id;
            $record->webcampicture = "{$url}";
            $record->status = $camshot->status;
            $record->timemodified = time();
            $record->captureorigin = $captureorigin;
            $record->tabswitchid = $tabswitchid;
            $screenshotid = $DB->insert_record('quizaccess_proctoring_logs', $record, true);
            $camshotlogid = $screenshotid;

            if ($captureorigin === 'violation' && $tabswitchid) {
                $DB->set_field('quizaccess_proctoring_tabswitch_logs', 'camshotlogid', $camshotlogid, ['id' => $tabswitchid]);
            }

            // Save the face image.
            $record = new stdClass();
            $record->filearea = 'face_image';
            $record->component = 'quizaccess_proctoring';
            $record->filepath = '';
            $record->itemid = $screenshotid;
            $record->license = '';
            $record->author = '';

            $context = context_module::instance($quizid);
            $fs = get_file_storage();
            $record->filepath = file_correct_filepath($record->filepath);

            $url = "";
            if ($faceimage) {
                // For base64 to file.
                $data = $faceimage;
                list(, $data) = explode(';', $data);
                $url = self::quizaccess_proctoring_geturl_without_timecode(
                    $data, $screenshotid, $USER, $courseid, $record, $context, $fs);
            }
            $record = new stdClass();
            $record->parent_type = $parenttype;
            $record->parentid = $screenshotid;
            $record->faceimage = "{$url}";
            $record->facefound = $facefound;
            $record->timemodified = time();
            $screenshotid = $DB->insert_record('quizaccess_proctoring_face_images', $record, true);

            $result = [];
            $result['screenshotid'] = $screenshotid;
            $result['warnings'] = $warnings;
        } else {
            $result = [];
            $result['screenshotid'] = 100;
            $result['warnings'] = [];
        }

        return $result;
    }

    /**
     * Return structure for sending cam shots.
     *
     * This function defines the structure of the response that is returned after
     * sending a cam shot. It includes the `screenshotid` which is the identifier
     * for the stored screenshot and any warnings that might have occurred during
     * the operation.
     *
     * @return external_single_structure The structure of the return value, which contains:
     *      - 'screenshotid' (int): The ID of the screenshot that was sent.
     *      - 'warnings' (array): An array containing any warnings encountered during the process.
     */
    public static function send_camshot_returns() {
        return new external_single_structure(
            [
                'screenshotid' => new external_value(PARAM_INT, 'screenshot sent id'),
                'warnings' => new external_warnings(),
            ]
        );
    }

    /**
     * Defines the parameters required for sending a screen (desktop) capture.
     *
     * @return external_function_parameters The required parameters.
     */
    public static function send_screenshot_parameters() {
        return new external_function_parameters(
            [
                'courseid' => new external_value(PARAM_INT, 'course id'),
                'screenshotlogid' => new external_value(PARAM_INT, 'pre-created quizaccess_proctoring_screenshot_logs id'),
                'quizid' => new external_value(PARAM_INT, 'screenshot quiz id (cmid)'),
                'screenshotpicture' => new external_value(PARAM_RAW, 'screen capture photo'),
                'captureorigin' => new external_value(
                    PARAM_ALPHA, 'Whether this was an interval or violation capture', VALUE_DEFAULT, 'interval'),
                'tabswitchid' => new external_value(
                    PARAM_INT, 'Linked quizaccess_proctoring_tabswitch_logs id, 0 if none', VALUE_DEFAULT, 0),
            ]
        );
    }

    /**
     * Store a screen (desktop) capture in Moodle subsystems and insert into the screenshot log table.
     *
     * Mirrors send_camshot(), but stores into quizaccess_proctoring_screenshot_logs under a
     * distinct 'screenshot' filearea, since screen captures are a separate capture stream from
     * webcam camshots.
     *
     * @param int $courseid The course ID where the proctoring took place.
     * @param int $screenshotlogid The ID of the pre-created screenshot log row.
     * @param int $quizid The cmid associated with the screenshot.
     * @param string $screenshotpicture The base64-encoded screen capture image.
     * @param string $captureorigin Either 'interval' or 'violation'.
     * @param int $tabswitchid The linked tab-switch violation id, 0 if none.
     *
     * @return array Returns an array with 'screenshotlogid' and 'warnings'.
     *
     * @throws dml_exception If there is a problem with database interaction.
     * @throws file_exception If there is an issue storing or retrieving files.
     * @throws invalid_parameter_exception If one or more parameters are invalid.
     * @throws stored_file_creation_exception If there is a problem creating or storing files.
     */
    public static function send_screenshot(
        $courseid, $screenshotlogid, $quizid, $screenshotpicture, $captureorigin = 'interval', $tabswitchid = 0) {
        global $DB, $USER;

        self::validate_parameters(
            self::send_screenshot_parameters(),
            [
                'courseid' => $courseid,
                'screenshotlogid' => $screenshotlogid,
                'quizid' => $quizid,
                'screenshotpicture' => $screenshotpicture,
                'captureorigin' => $captureorigin,
                'tabswitchid' => $tabswitchid,
            ]
        );

        $context = context_course::instance($courseid);
        if (
            !is_enrolled($context, $USER->id, 'mod/quiz:attempt') &&
            !has_capability('mod/quiz:grade', $context)
        ) {
            throw new moodle_exception(
                'accessdenied', 'quizaccess_proctoring', '', null,
                get_string('notenrolled', 'quizaccess_proctoring')
            );
        }

        $warnings = [];

        $record = new stdClass();
        $record->filearea = 'screenshot';
        $record->component = 'quizaccess_proctoring';
        $record->filepath = '';
        $record->itemid = $screenshotlogid;
        $record->license = '';
        $record->author = '';

        $modcontext = context_module::instance($quizid);
        $fs = get_file_storage();
        $record->filepath = file_correct_filepath($record->filepath);

        // For base64 to file.
        $data = $screenshotpicture;
        list(, $data) = explode(';', $data);
        $url = self::geturl($data, $screenshotlogid, $USER, $courseid, $record, $modcontext, $fs);

        $record = new stdClass();
        $record->courseid = $courseid;
        $record->quizid = $quizid;
        $record->userid = $USER->id;
        $record->screenshotpicture = "{$url}";
        $record->captureorigin = $captureorigin;
        $record->tabswitchid = $tabswitchid;
        $record->status = 0;
        $record->timemodified = time();
        $screenshotlogid = $DB->insert_record('quizaccess_proctoring_screenshot_logs', $record, true);

        if ($captureorigin === 'violation' && $tabswitchid) {
            $DB->set_field(
                'quizaccess_proctoring_tabswitch_logs', 'screenshotlogid', $screenshotlogid, ['id' => $tabswitchid]);
        }

        $result = [];
        $result['screenshotlogid'] = $screenshotlogid;
        $result['warnings'] = $warnings;

        return $result;
    }

    /**
     * Return structure for sending screen captures.
     *
     * @return external_single_structure
     */
    public static function send_screenshot_returns() {
        return new external_single_structure(
            [
                'screenshotlogid' => new external_value(PARAM_INT, 'screenshot log id sent'),
                'warnings' => new external_warnings(),
            ]
        );
    }

    /**
     * Defines the parameters required for logging a tab-switch/focus-loss violation event.
     *
     * @return external_function_parameters
     */
    public static function log_tabswitch_parameters() {
        return new external_function_parameters(
            [
                'courseid' => new external_value(PARAM_INT, 'course id'),
                'quizid' => new external_value(PARAM_INT, 'quiz id (cmid)'),
                'attemptid' => new external_value(PARAM_INT, 'quiz attempt id', VALUE_DEFAULT, 0),
                'eventtype' => new external_value(PARAM_ALPHA, 'blur or visibilitychange'),
                'starttime' => new external_value(PARAM_INT, 'epoch seconds when the student switched away'),
                'duration' => new external_value(PARAM_INT, 'seconds spent away before returning'),
            ]
        );
    }

    /**
     * Logs a single tab-switch/focus-loss violation event (one row per switch-away/return pair).
     *
     * @param int $courseid The course ID.
     * @param int $quizid The cmid.
     * @param int $attemptid The quiz attempt id.
     * @param string $eventtype Either 'blur' or 'visibilitychange'.
     * @param int $starttime Epoch seconds when the student switched away.
     * @param int $duration Seconds spent away before returning.
     *
     * @return array Returns an array with 'tabswitchid' and 'warnings'.
     * @throws dml_exception If there is a problem with database interaction.
     * @throws invalid_parameter_exception If one or more parameters are invalid.
     */
    public static function log_tabswitch($courseid, $quizid, $attemptid, $eventtype, $starttime, $duration) {
        global $DB, $USER;

        self::validate_parameters(
            self::log_tabswitch_parameters(),
            [
                'courseid' => $courseid,
                'quizid' => $quizid,
                'attemptid' => $attemptid,
                'eventtype' => $eventtype,
                'starttime' => $starttime,
                'duration' => $duration,
            ]
        );

        $context = context_course::instance($courseid);
        if (
            !is_enrolled($context, $USER->id, 'mod/quiz:attempt') &&
            !has_capability('mod/quiz:grade', $context)
        ) {
            throw new moodle_exception(
                'accessdenied', 'quizaccess_proctoring', '', null,
                get_string('notenrolled', 'quizaccess_proctoring')
            );
        }

        $record = new stdClass();
        $record->courseid = $courseid;
        $record->quizid = $quizid;
        $record->userid = $USER->id;
        $record->attemptid = $attemptid;
        $record->eventtype = $eventtype;
        $record->starttime = $starttime;
        $record->duration = $duration;
        $record->camshotlogid = 0;
        $record->screenshotlogid = 0;
        $record->timecreated = time();
        $tabswitchid = $DB->insert_record('quizaccess_proctoring_tabswitch_logs', $record, true);

        return [
            'tabswitchid' => $tabswitchid,
            'warnings' => [],
        ];
    }

    /**
     * Return structure for logging a tab-switch violation event.
     *
     * @return external_single_structure
     */
    public static function log_tabswitch_returns() {
        return new external_single_structure(
            [
                'tabswitchid' => new external_value(PARAM_INT, 'id of the newly logged violation row'),
                'warnings' => new external_warnings(),
            ]
        );
    }

    /**
     * Defines the parameters for updating a tab-switch violation's final duration.
     *
     * @return external_function_parameters
     */
    public static function update_tabswitch_duration_parameters() {
        return new external_function_parameters(
            [
                'tabswitchid' => new external_value(PARAM_INT, 'tabswitch log id, from log_tabswitch'),
                'duration' => new external_value(PARAM_INT, 'seconds spent away before returning'),
            ]
        );
    }

    /**
     * Fills in the final duration of a tab-switch violation once the student returns.
     *
     * The violation row is created immediately when the student switches away (via
     * log_tabswitch(), with duration=0 as a placeholder) so that the resulting id can
     * be used right away to tag an in-the-moment webcam/screenshot capture. The final
     * duration is only known once the student comes back, hence this separate update.
     *
     * @param int $tabswitchid The tabswitch log id to update.
     * @param int $duration Seconds spent away before returning.
     *
     * @return array Returns an array with 'warnings'.
     * @throws invalid_parameter_exception If one or more parameters are invalid.
     */
    public static function update_tabswitch_duration($tabswitchid, $duration) {
        global $DB, $USER;

        self::validate_parameters(
            self::update_tabswitch_duration_parameters(),
            [
                'tabswitchid' => $tabswitchid,
                'duration' => $duration,
            ]
        );

        // Only allow a student to update their own violation row.
        if ($DB->record_exists('quizaccess_proctoring_tabswitch_logs', ['id' => $tabswitchid, 'userid' => $USER->id])) {
            $DB->set_field('quizaccess_proctoring_tabswitch_logs', 'duration', $duration, ['id' => $tabswitchid]);
        }

        return ['warnings' => []];
    }

    /**
     * Return structure for updating a tab-switch violation's duration.
     *
     * @return external_single_structure
     */
    public static function update_tabswitch_duration_returns() {
        return new external_single_structure(
            [
                'warnings' => new external_warnings(),
            ]
        );
    }

    /**
     * Adds a timestamp to the captured image.
     *
     * This function takes an image in raw data format, adds a timestamp in the
     * specified format to the image, and returns the updated image data.
     *
     * @param string $data The raw image data (in PNG or JPEG format) to which the timestamp will be added.
     * @return string The updated image data with the added timestamp.
     * @throws Exception If there is an issue with image creation or manipulation.
     */
    protected static function add_timecode_to_image($data) {
        global $CFG;

        $image = imagecreatefromstring($data);
        imagefilledrectangle($image, 0, 0, 120, 22, imagecolorallocatealpha($image, 255, 255, 255, 60));
        imagefttext($image, 9, 0, 4, 16, imagecolorallocate($image, 0, 0, 0),
            $CFG->dirroot . '/mod/quiz/accessrule/proctoring/assets/Roboto-Light.ttf', date('d-m-Y H:i:s') );
        ob_start();
        imagepng($image);
        $data = ob_get_clean();
        ob_end_clean();
        imagedestroy($image);
        return $data;
    }

    /**
     * Defines the parameters for the validate_face function.
     *
     * This function defines and returns the expected parameters for the
     * validate_face function, which includes information about the course,
     * the activity, the profile photo, webcam photo, face image, and face found flag.
     *
     * @return external_function_parameters The parameters required for the validate_face function.
     */
    public static function validate_face_parameters() {
        return new external_function_parameters(
            [
                'courseid' => new external_value(PARAM_INT, 'course id'),
                'cmid' => new external_value(PARAM_INT, 'cm id'),
                'profileimage' => new external_value(PARAM_RAW, 'profile photo'),
                'webcampicture' => new external_value(PARAM_RAW, 'webcam photo'),
                'parenttype' => new external_value(PARAM_RAW, 'Face image parent type'),
                'faceimage' => new external_value(PARAM_RAW, 'Face Image'),
                'facefound' => new external_value(PARAM_INT, 'Face found flag'),
            ]
        );
    }

    /**
     * Stores the captured Cam shots in Moodle subsystems and logs them in the database.
     *
     * This function validates the parameters, processes the webcam and face images, stores them in Moodle's
     * file storage, inserts a record in the `quizaccess_proctoring_logs` and `quizaccess_proctoring_face_images` tables,
     * performs face checking, and returns the result along with warnings if applicable.
     *
     * @param mixed $courseid The course ID.
     * @param mixed $cmid The course module ID.
     * @param mixed $profileimage The profile image of the user.
     * @param mixed $webcampicture The webcam image captured.
     * @param mixed $parenttype The type of parent image (e.g., Admin or Webcam).
     * @param mixed $faceimage The face image captured.
     * @param bool $facefound Flag indicating whether a face was detected (0 or 1).
     *
     * @return array An array containing the `screenshotid`, `status`, and `warnings`.
     *
     * @throws dml_exception If there is a database issue.
     * @throws file_exception If there is an issue with file handling.
     * @throws invalid_parameter_exception If any of the parameters are invalid.
     * @throws stored_file_creation_exception If there is an error creating the stored file.
     */
    public static function validate_face($courseid, $cmid, $profileimage, $webcampicture, $parenttype, $faceimage, $facefound) {
        global $DB, $USER, $CFG;

        // Validate the params.
        self::validate_parameters(
            self::validate_face_parameters(),
            [
                'courseid' => $courseid,
                'cmid' => $cmid,
                'profileimage' => $profileimage,
                'webcampicture' => $webcampicture,
                'parenttype' => $parenttype,
                'faceimage' => $faceimage,
                'facefound' => $facefound,
            ]
        );

        // Check if the user is enrolled in the course as a student or teacher.
        $context = context_course::instance($courseid);

        if (
            !is_enrolled($context, $USER->id, 'mod/quiz:attempt') && // Check student capability.
            !has_capability('mod/quiz:grade', $context)              // Check teacher capability.
        ) {
            throw new moodle_exception(
                'accessdenied', 'quizaccess_proctoring', '', null,
                get_string('notenrolled', 'quizaccess_proctoring')
            );
        }

        $warnings = [];
        $screenshotid = time();
        $record = new stdClass();
        $record->filearea = 'picture';
        $record->component = 'quizaccess_proctoring';
        $record->filepath = '';
        $record->itemid = $screenshotid;
        $record->license = '';
        $record->author = '';

        $context = context_module::instance($cmid);
        $fs = get_file_storage();
        $record->filepath = file_correct_filepath($record->filepath);

        // For base64 to file.
        $data = $webcampicture;
        $url = self::geturl($data, $screenshotid, $USER, $courseid, $record, $context, $fs);

        $record = new stdClass();
        $record->courseid = $courseid;
        $record->quizid = $cmid;
        $record->userid = $USER->id;
        $record->webcampicture = "{$url}";
        $record->status = $screenshotid;
        $record->timemodified = time();
        $screenshotid = $DB->insert_record('quizaccess_proctoring_logs', $record, true);

        // Save the face image.
        $record = new stdClass();
        $record->filearea = 'face_image';
        $record->component = 'quizaccess_proctoring';
        $record->filepath = '';
        $record->itemid = $screenshotid;
        $record->license = '';
        $record->author = '';

        $context = context_module::instance($cmid);
        $fs = get_file_storage();
        $record->filepath = file_correct_filepath($record->filepath);

        $url = "";
        if ($faceimage) {
            // For base64 to file.
            $data = $faceimage;
            list(, $data) = explode(';', $data);
            $url = self::quizaccess_proctoring_geturl_without_timecode(
                $data, $screenshotid, $USER, $courseid, $record, $context, $fs);
        }
        $record = new stdClass();
        $record->parent_type = $parenttype;
        $record->parentid = $screenshotid;
        $record->faceimage = "{$url}";
        $record->facefound = $facefound;
        $record->timemodified = time();
        $faceimageid = $DB->insert_record('quizaccess_proctoring_face_images', $record, true);
        $profileimageurl = quizaccess_proctoring_get_image_url( $USER->id);
        if ($profileimageurl == false) {
            $result = [];
            $result['screenshotid'] = $screenshotid;
            $result['status'] = 'photonotuploaded';
            $result['warnings'] = $warnings;
            return $result;
        }

        // Face check.
        require_once($CFG->dirroot.'/mod/quiz/accessrule/proctoring/lib.php');
        $method = quizaccess_proctoring_get_proctoring_settings("fcmethod");
        if ($method == "BS") {
            quizaccess_proctoring_bs_analyze_specific_image_from_validate($screenshotid);
        }

        $currentdata = $DB->get_record('quizaccess_proctoring_logs', ['id' => $screenshotid]);
        $awsscore = $currentdata->awsscore;
        $threshhold = (int)quizaccess_proctoring_get_proctoring_settings('threshold');

        if ($awsscore > $threshhold) {
            $status = "success";
        } else {
            $status = "failed";
        }

        $result = [];
        $result['screenshotid'] = $screenshotid;
        $result['status'] = $status;
        $result['warnings'] = $warnings;
        // API is invalid or not set.
        if ($currentdata->awsflag == 101) {
            $result['status'] = 'invalidApi';
        }
        return $result;
    }


    /**
     * Returns the structure for the cam shots validation response.
     *
     * This function defines the structure of the returned data when a cam shot validation is performed.
     * It returns the screenshot ID, validation status, and any warnings encountered during the process.
     *
     * @return external_single_structure A single structure containing:
     *  - 'screenshotid' => The ID of the screenshot sent for validation (integer).
     *  - 'status' => The response status of the validation (string).
     *  - 'warnings' => Any warnings encountered during validation (external_warnings).
     */
    public static function validate_face_returns() {
        return new external_single_structure(
            [
                'screenshotid' => new external_value(PARAM_INT, 'screenshot sent id'),
                'status' => new external_value(PARAM_TEXT, 'validation response'),
                'warnings' => new external_warnings(),
            ]
        );
    }

    /**
     * Returns the image URL from image data after adding a timecode at the top of the image.
     *
     * This function processes the base64 encoded image data, adds a timecode, and stores the image in Moodle's file system.
     * It then returns the URL of the stored image file.
     *
     * @param string $data The base64 encoded image data.
     * @param int $screenshotid The unique ID of the screenshot.
     * @param object $USER The current user object.
     * @param int $courseid The ID of the course.
     * @param stdClass $record The record object used to store file metadata.
     * @param context $context The context in which the file will be stored.
     * @param mixed $fs The file storage instance to handle file operations.
     * @return mixed The URL of the stored image file with the timecode added.
     */
    protected static function geturl(string $data, int $screenshotid, $USER, int $courseid, stdClass $record, $context, $fs) {
        list(, $data) = explode(',', $data);
        $data = base64_decode($data);
        $filename = $record->filearea . '-' . $screenshotid . '-' . $USER->id . '-' . $courseid . '-'
            . time() . random_int(1, 1000) . '.png';

        $data = self::add_timecode_to_image($data);

        $record->courseid = $courseid;
        $record->filename = $filename;
        $record->contextid = $context->id;
        $record->userid = $USER->id;

        $fs->create_file_from_string($record, $data);

        return moodle_url::make_pluginfile_url(
            $context->id,
            $record->component,
            $record->filearea,
            $record->itemid,
            $record->filepath,
            $record->filename,
            false
        );
    }

    /**
     * Returns the image URL without adding a timecode at the top of the image.
     *
     * This function processes the base64 encoded image data, stores the image in Moodle's file system without adding a timecode,
     * and then returns the URL of the stored image file.
     *
     * @param string $data The base64 encoded image data.
     * @param int $screenshotid The unique ID of the screenshot.
     * @param object $USER The current user object.
     * @param int $courseid The ID of the course.
     * @param stdClass $record The record object used to store file metadata.
     * @param mixed $context The context in which the file will be stored.
     * @param mixed $fs The file storage instance to handle file operations.
     * @return mixed The URL of the stored image file without the timecode added.
     */
    private static function quizaccess_proctoring_geturl_without_timecode(
        string $data, int $screenshotid, $USER, int $courseid, stdClass $record, $context, $fs) {
        list(, $data) = explode(',', $data);
        $data = base64_decode($data);
        $filename = 'webcam-' . $screenshotid . '-' . $USER->id . '-' . $courseid . '-' . time() . random_int(1, 1000) . '.png';

        $record->courseid = $courseid;
        $record->filename = $filename;
        $record->contextid = $context->id;
        $record->userid = $USER->id;

        $fs->create_file_from_string($record, $data);

        return moodle_url::make_pluginfile_url(
            $context->id,
            $record->component,
            $record->filearea,
            $record->itemid,
            $record->filepath,
            $record->filename,
            false
        );
    }
}
