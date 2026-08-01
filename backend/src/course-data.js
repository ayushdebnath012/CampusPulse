// CampusPulse ships with no courses. A professor creates each course and
// uploads its roll list, so there is nothing to seed from configuration.
function buildCourseData() {
  return { courses: [], courseStudents: [] };
}

module.exports = { buildCourseData };
